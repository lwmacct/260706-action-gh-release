import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  architectureAliases,
  chmodExecutable,
  formatNames,
  hashFile,
  includesAny,
  isArchive,
  isLikelyExecutable,
  isMovingTag,
  isSupplementalAsset,
  listFiles,
  matchesGlob,
  moveFile,
  normalizeChecksum,
  normalizePath,
  normalizeRename,
  platformAliases,
  relativeMetadataPath,
  relativeNames,
  tarFlags,
  unique,
  verifySha256,
} from "./utils.js";

const nativeRequire = createRequire(import.meta.url);
const requireMap = new Map<string, unknown>();
const compatRequire = (specifier: string): unknown => {
  if (requireMap.has(specifier)) {
    return requireMap.get(specifier);
  }
  return nativeRequire(specifier);
};
Object.assign(globalThis, { require: compatRequire });

let cache: typeof import("@actions/cache");
let core: typeof import("@actions/core");
let tc: typeof import("@actions/tool-cache");

const ACTION_NAME = "gh-release";
const CACHE_KEY_PREFIX = "gh-release";
const CACHE_SCHEMA_VERSION = "v1";
const INSTALL_METADATA_FILE = "metadata.json";
const ASSET_DIR = "asset";
const BIN_DIR = "bin";
const RELEASE_DIR = "release";

interface Inputs {
  githubToken: string;
  owner: string;
  repo: string;
  tag: string;
  assetPattern: string;
  binaryPattern: string;
  checksum: string;
  cacheEnabled: boolean;
  rename: string;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

interface ListedRelease extends Release {
  draft: boolean;
  prerelease: boolean;
}

interface ReleaseAsset {
  id: number;
  name: string;
  url: string;
  size: number;
  updated_at: string;
}

interface InstallMetadata {
  releaseTag: string;
  assetId: number;
  assetName: string;
  assetSize: number;
  assetUpdatedAt: string;
  installDir: string;
  assetPath: string;
  binDirs: string[];
  binaryPaths: string[];
  checksum: string;
}

interface StoredInstallMetadata {
  releaseTag: string;
  assetId: number;
  assetName: string;
  assetSize: number;
  assetUpdatedAt: string;
  assetPath: string;
  binDirs: string[];
  binaryPaths: string[];
  checksum: string;
}

interface InstallResult {
  installDir: string;
  assetPath: string;
  binDirs: string[];
  binaryPaths: string[];
}

async function run(): Promise<void> {
  try {
    await loadActionsToolkit();

    const inputs = getInputs();
    const release = await getRelease(inputs);
    const asset = selectAsset(release.assets, inputs);
    const cacheKey = getCacheKey(inputs, asset);
    const installRoot = getInstallRoot(inputs, asset);
    core.info(`Install directory: ${installRoot}`);
    if (cacheKey) {
      core.info(`Cache key: ${cacheKey}`);
    }

    if (inputs.cacheEnabled && cacheKey) {
      const restoredKey = await cache.restoreCache([installRoot], cacheKey);
      if (restoredKey) {
        const metadata = readInstallMetadata(installRoot, asset);
        const releaseDownloadUrl = materializeReleaseDownloadUrl(metadata, asset);
        core.info(`Restored ${restoredKey} from cache`);
        addPaths(metadata.binDirs);
        setOutputs(metadata, true, releaseDownloadUrl);
        return;
      }
    }

    core.info(`Installing ${asset.name} into ${installRoot}`);
    fs.rmSync(installRoot, { force: true, recursive: true });

    const downloadedAsset = await downloadAsset(asset, inputs.githubToken);
    const actualChecksum = await hashFile(downloadedAsset);
    if (inputs.checksum) {
      verifySha256(actualChecksum, inputs.checksum);
    }

    const installResult = await installAsset(downloadedAsset, asset.name, installRoot, inputs);
    const metadata: InstallMetadata = {
      releaseTag: release.tag_name,
      assetId: asset.id,
      assetName: asset.name,
      assetSize: asset.size,
      assetUpdatedAt: asset.updated_at,
      installDir: installResult.installDir,
      assetPath: installResult.assetPath,
      binDirs: installResult.binDirs,
      binaryPaths: installResult.binaryPaths,
      checksum: actualChecksum,
    };
    writeInstallMetadata(installRoot, metadata);
    const releaseDownloadUrl = materializeReleaseDownloadUrl(metadata, asset);

    if (inputs.cacheEnabled && cacheKey) {
      await saveCache(installRoot, cacheKey);
    }

    addPaths(metadata.binDirs);
    setOutputs(metadata, false, releaseDownloadUrl);
    core.info(`Added ${formatNames(metadata.binDirs)} to PATH`);
  } catch (error) {
    if (core) {
      core.setFailed(error instanceof Error ? error.message : "Unexpected failure");
    } else {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}

async function loadActionsToolkit(): Promise<void> {
  const [protobufRuntime, supportsColor] = await Promise.all([
    import("@protobuf-ts/runtime"),
    import("supports-color"),
  ]);
  requireMap.set("@protobuf-ts/runtime", protobufRuntime);
  requireMap.set("supports-color", supportsColor.default);

  [cache, core, tc] = await Promise.all([
    import("@actions/cache"),
    import("@actions/core"),
    import("@actions/tool-cache"),
  ]);
}

function getInputs(): Inputs {
  const repository = core.getInput("repository", { required: true });
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new Error("repository must use owner/repo format");
  }

  const tag = core.getInput("tag") || "latest";
  const checksum = normalizeChecksum(core.getInput("checksum"));
  const cacheEnabled = getBooleanInput("cache");
  if (cacheEnabled && isMovingTag(tag)) {
    core.info(`Cache is disabled for moving tag ${tag}`);
  }

  return {
    githubToken: core.getInput("github-token"),
    owner,
    repo,
    tag,
    assetPattern: core.getInput("asset"),
    binaryPattern: core.getInput("binary"),
    checksum,
    cacheEnabled: cacheEnabled && !isMovingTag(tag),
    rename: normalizeRename(core.getInput("rename")),
  };
}

function getBooleanInput(name: string): boolean {
  const value = core.getInput(name).toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

async function getRelease(inputs: Inputs): Promise<Release> {
  if (inputs.tag === "latest") {
    return githubJson<Release>(inputs, `/repos/${inputs.owner}/${inputs.repo}/releases/latest`);
  }

  if (inputs.tag === "latest-prerelease") {
    for (let page = 1; ; page += 1) {
      const releases = await githubJson<ListedRelease[]>(
        inputs,
        `/repos/${inputs.owner}/${inputs.repo}/releases?per_page=100&page=${page}`,
      );
      const release = releases.find((item) => item.prerelease && !item.draft);
      if (release) {
        return release;
      }
      if (releases.length < 100) {
        throw new Error("No prerelease found");
      }
    }
  }

  return githubJson<Release>(inputs, `/repos/${inputs.owner}/${inputs.repo}/releases/tags/${encodeURIComponent(inputs.tag)}`);
}

async function githubJson<T>(inputs: Inputs, pathname: string): Promise<T> {
  const response = await githubFetch(inputs.githubToken, `${githubApiBaseUrl()}${pathname}`, {
    accept: "application/vnd.github+json",
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function downloadAsset(asset: ReleaseAsset, token: string): Promise<string> {
  const response = await githubFetch(token, asset.url, {
    accept: "application/octet-stream",
  });

  if (!response.ok) {
    throw new Error(`Asset download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`Asset download produced an empty response body: ${asset.name}`);
  }

  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-asset-")),
    path.basename(asset.name),
  );

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  return filePath;
}

async function githubFetch(
  token: string,
  url: string,
  headers: { accept: string },
): Promise<Response> {
  const requestHeaders: Record<string, string> = {
    Accept: headers.accept,
    "User-Agent": "gh-release-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    requestHeaders["Authorization"] = `Bearer ${token}`;
  }

  return fetch(url, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(30000),
  });
}

function githubApiBaseUrl(): string {
  return process.env["GITHUB_API_URL"] || "https://api.github.com";
}

function selectAsset(assets: ReleaseAsset[], inputs: Inputs): ReleaseAsset {
  if (assets.length === 0) {
    throw new Error("Release has no assets");
  }

  const matches = inputs.assetPattern
    ? assets.filter((asset) => matchesGlob(asset.name, inputs.assetPattern))
    : autoSelectAssetMatches(assets);

  if (matches.length === 1) {
    const asset = matches[0];
    if (!asset) {
      throw new Error("Matched asset disappeared unexpectedly");
    }
    core.info(`Matched release asset: ${asset.name}`);
    return asset;
  }

  if (matches.length > 1) {
    throw new Error(`Multiple release assets matched: ${formatNames(matches.map((asset) => asset.name))}`);
  }

  throw new Error(`No release asset matched. Available assets: ${formatNames(assets.map((asset) => asset.name))}`);
}

function autoSelectAssetMatches(assets: ReleaseAsset[]): ReleaseAsset[] {
  const candidates = assets.filter((asset) => !isSupplementalAsset(asset.name));
  const osAliases = platformAliases(os.platform());
  const archAliases = architectureAliases(os.arch());

  const osAndArchMatches = candidates.filter((asset) => {
    const name = asset.name.toLowerCase();
    return includesAny(name, osAliases) && includesAny(name, archAliases);
  });
  if (osAndArchMatches.length > 0) {
    return osAndArchMatches;
  }

  const osMatches = candidates.filter((asset) => includesAny(asset.name.toLowerCase(), osAliases));
  if (osMatches.length === 1) {
    return osMatches;
  }

  if (candidates.length === 1) {
    return candidates;
  }

  return [];
}

async function installAsset(
  assetPath: string,
  assetName: string,
  installRoot: string,
  inputs: Inputs,
): Promise<InstallResult> {
  fs.mkdirSync(installRoot, { recursive: true });
  const installedAssetPath = path.join(installRoot, ASSET_DIR, assetName);
  fs.mkdirSync(path.dirname(installedAssetPath), { recursive: true });
  moveFile(assetPath, installedAssetPath);
  core.info(`Stored release asset ${installedAssetPath}`);

  if (isArchive(assetName)) {
    const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-extract-"));
    await extractArchive(installedAssetPath, assetName, extractRoot);
    const archiveResult = installArchiveBinary(extractRoot, installRoot, installedAssetPath, inputs);
    fs.rmSync(extractRoot, { force: true, recursive: true });
    return archiveResult;
  }

  return installSingleBinary(installedAssetPath, assetName, installRoot, inputs);
}

async function extractArchive(assetPath: string, assetName: string, destination: string): Promise<void> {
  fs.mkdirSync(destination, { recursive: true });

  if (assetName.toLowerCase().endsWith(".zip")) {
    await tc.extractZip(assetPath, destination);
    return;
  }

  await tc.extractTar(assetPath, destination, tarFlags(assetName));
}

function installArchiveBinary(
  extractRoot: string,
  installRoot: string,
  assetPath: string,
  inputs: Inputs,
): InstallResult {
  const sources = selectInstalledBinaries(extractRoot, inputs.binaryPattern);
  if (inputs.rename && sources.length !== 1) {
    throw new Error("rename is only supported when exactly one binary is installed");
  }

  const binaryPaths = sources.map((source) => {
    const relativeSource = normalizePath(path.relative(extractRoot, source));
    const target = path.join(installRoot, BIN_DIR, inputs.rename || relativeSource);
    if (fs.existsSync(target)) {
      throw new Error(`Cannot install binary because target already exists: ${target}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    moveFile(source, target);
    chmodExecutable(target);
    core.info(`Installed ${target}`);
    return target;
  });

  return {
    installDir: installRoot,
    assetPath,
    binDirs: unique(binaryPaths.map((binaryPath) => path.dirname(binaryPath))),
    binaryPaths,
  };
}

function installSingleBinary(
  assetPath: string,
  assetName: string,
  installRoot: string,
  inputs: Inputs,
): InstallResult {
  const target = path.join(installRoot, BIN_DIR, inputs.rename || path.basename(assetName));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = linkOrCopy(assetPath, target);
  chmodExecutable(target);
  core.info(`Installed ${target} from asset using ${mode}`);
  return {
    installDir: installRoot,
    assetPath,
    binDirs: [path.dirname(target)],
    binaryPaths: [target],
  };
}

function linkOrCopy(source: string, target: string): "hardlink" | "symlink" | "copy" {
  fs.rmSync(target, { force: true });
  try {
    fs.linkSync(source, target);
    return "hardlink";
  } catch {
    try {
      fs.symlinkSync(source, target);
      return "symlink";
    } catch {
      fs.copyFileSync(source, target);
      return "copy";
    }
  }
}

function selectInstalledBinaries(installRoot: string, binaryPattern: string): string[] {
  const files = listFiles(installRoot).filter((file) => path.basename(file) !== INSTALL_METADATA_FILE);
  if (files.length === 0) {
    throw new Error(`No files were installed in ${installRoot}`);
  }

  if (binaryPattern) {
    const matches = files.filter((file) => matchesBinaryPattern(installRoot, file, binaryPattern));
    if (matches.length > 0) {
      return matches;
    }
    throw new Error(`No installed binary matched. Available files: ${formatNames(relativeNames(installRoot, files))}`);
  }

  const executableFiles = files.filter(isLikelyExecutable);
  if (executableFiles.length > 0) {
    return executableFiles;
  }

  if (files.length === 1) {
    const file = files[0];
    if (!file) {
      throw new Error("Installed file disappeared unexpectedly");
    }
    return [file];
  }

  throw new Error(`No executable file found. Set binary to one of: ${formatNames(relativeNames(installRoot, files))}`);
}

function matchesBinaryPattern(installRoot: string, filePath: string, pattern: string): boolean {
  const relativePath = normalizePath(path.relative(installRoot, filePath));
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPattern.includes("/")) {
    return matchesGlob(path.basename(relativePath), normalizedPattern);
  }
  return matchesGlob(relativePath, normalizedPattern);
}

function getInstallRoot(inputs: Inputs, asset: ReleaseAsset): string {
  const baseDir = process.env["RUNNER_TOOL_CACHE"] || process.env["RUNNER_TEMP"] || os.tmpdir();
  return path.join(
    baseDir,
    ACTION_NAME,
    inputs.owner,
    inputs.repo,
    inputs.tag,
    runnerPlatformKey(),
    installFingerprint(inputs, asset),
  );
}

function getCacheKey(inputs: Inputs, asset: ReleaseAsset): string | undefined {
  if (!inputs.cacheEnabled) {
    return undefined;
  }

  return [
    CACHE_KEY_PREFIX,
    CACHE_SCHEMA_VERSION,
    inputs.owner,
    inputs.repo,
    inputs.tag,
    runnerPlatformKey(),
    installFingerprint(inputs, asset),
  ].join("/");
}

function runnerPlatformKey(): string {
  return `${os.platform()}-${os.arch()}`;
}

function installFingerprint(inputs: Inputs, asset: ReleaseAsset): string {
  const fingerprintSource = JSON.stringify({
    assetId: asset.id,
    assetName: asset.name,
    assetSize: asset.size,
    assetUpdatedAt: asset.updated_at,
    checksum: inputs.checksum,
    binaryPattern: inputs.binaryPattern,
    rename: inputs.rename,
  });
  return crypto.createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 12);
}

async function saveCache(installRoot: string, cacheKey: string): Promise<void> {
  try {
    await cache.saveCache([installRoot], cacheKey);
    core.info(`Saved ${installRoot} to cache with key ${cacheKey}`);
  } catch (error) {
    const typedError = error as Error;
    if (typedError.name === cache.ValidationError.name) {
      throw error;
    }
    if (typedError.name === cache.ReserveCacheError.name) {
      core.info(typedError.message);
      return;
    }
    core.warning(typedError.message);
  }
}

function readInstallMetadata(installRoot: string, asset: ReleaseAsset): InstallMetadata {
  const metadataPath = path.join(installRoot, INSTALL_METADATA_FILE);
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Cached installation is missing metadata: ${metadataPath}`);
  }

  const storedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as StoredInstallMetadata;
  if (
    typeof storedMetadata.assetPath !== "string" ||
    !Array.isArray(storedMetadata.binDirs) ||
    !Array.isArray(storedMetadata.binaryPaths)
  ) {
    throw new Error(`Cached installation metadata is incompatible with ${CACHE_SCHEMA_VERSION}: ${metadataPath}`);
  }
  const metadata: InstallMetadata = {
    releaseTag: storedMetadata.releaseTag,
    assetId: storedMetadata.assetId,
    assetName: storedMetadata.assetName,
    assetSize: storedMetadata.assetSize,
    assetUpdatedAt: storedMetadata.assetUpdatedAt,
    installDir: installRoot,
    assetPath: path.join(installRoot, storedMetadata.assetPath),
    binDirs: storedMetadata.binDirs.map((binDir) => path.join(installRoot, binDir)),
    binaryPaths: storedMetadata.binaryPaths.map((binaryPath) => path.join(installRoot, binaryPath)),
    checksum: storedMetadata.checksum,
  };
  verifyCachedAssetMetadata(metadata, asset);
  if (!fs.existsSync(metadata.assetPath)) {
    throw new Error(`Cached asset does not exist: ${metadata.assetPath}`);
  }
  for (const binaryPath of metadata.binaryPaths) {
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Cached binary does not exist: ${binaryPath}`);
    }
  }
  return metadata;
}

function writeInstallMetadata(installRoot: string, metadata: InstallMetadata): void {
  const storedMetadata: StoredInstallMetadata = {
    releaseTag: metadata.releaseTag,
    assetId: metadata.assetId,
    assetName: metadata.assetName,
    assetSize: metadata.assetSize,
    assetUpdatedAt: metadata.assetUpdatedAt,
    assetPath: relativeMetadataPath(installRoot, metadata.assetPath),
    binDirs: metadata.binDirs.map((binDir) => relativeMetadataPath(installRoot, binDir)),
    binaryPaths: metadata.binaryPaths.map((binaryPath) => relativeMetadataPath(installRoot, binaryPath)),
    checksum: metadata.checksum,
  };
  fs.writeFileSync(path.join(installRoot, INSTALL_METADATA_FILE), `${JSON.stringify(storedMetadata, null, 2)}\n`);
}

function materializeReleaseDownloadUrl(metadata: InstallMetadata, asset: ReleaseAsset): string {
  if (!metadata.assetPath) {
    return "";
  }

  const downloadRoot = path.join(metadata.installDir, RELEASE_DIR);
  const target = path.join(downloadRoot, metadata.releaseTag, asset.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });

  try {
    fs.linkSync(metadata.assetPath, target);
    core.info(`Created release download layout with hardlink: ${target} -> ${metadata.assetPath}`);
  } catch (hardlinkError) {
    try {
      fs.symlinkSync(metadata.assetPath, target);
      core.info(`Created release download layout with symlink: ${target} -> ${metadata.assetPath}`);
    } catch (symlinkError) {
      const hardlinkMessage = hardlinkError instanceof Error ? hardlinkError.message : String(hardlinkError);
      const symlinkMessage = symlinkError instanceof Error ? symlinkError.message : String(symlinkError);
      core.warning(`Could not create release download layout: hardlink failed: ${hardlinkMessage}; symlink failed: ${symlinkMessage}`);
      return "";
    }
  }

  return pathToFileURL(downloadRoot).href;
}

function verifyCachedAssetMetadata(metadata: InstallMetadata, asset: ReleaseAsset): void {
  if (
    metadata.assetId !== asset.id ||
    metadata.assetName !== asset.name ||
    metadata.assetSize !== asset.size ||
    metadata.assetUpdatedAt !== asset.updated_at
  ) {
    throw new Error("Cached installation metadata does not match the selected GitHub release asset");
  }
}

function setOutputs(metadata: InstallMetadata, cacheHit: boolean, releaseDownloadUrl: string): void {
  core.setOutput("release-tag", metadata.releaseTag);
  core.setOutput("asset-name", metadata.assetName);
  core.setOutput("install-dir", metadata.installDir);
  core.setOutput("asset-path", metadata.assetPath);
  core.setOutput("bin-dir", metadata.binDirs[0] || "");
  core.setOutput("binary-path", metadata.binaryPaths[0] || "");
  core.setOutput("bin-dirs", JSON.stringify(metadata.binDirs));
  core.setOutput("binary-paths", JSON.stringify(metadata.binaryPaths));
  core.setOutput("checksum", metadata.checksum);
  core.setOutput("cache-hit", cacheHit ? "true" : "false");
  core.setOutput("release-download-url", releaseDownloadUrl);
}

function addPaths(binDirs: string[]): void {
  for (const binDir of binDirs) {
    core.addPath(binDir);
  }
}

void run();
