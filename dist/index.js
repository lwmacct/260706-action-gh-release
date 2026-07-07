import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const TAR_EXTENSIONS = [".tar.gz", ".tar.xz", ".tar.bz2", ".tgz"];
const WINDOWS_EXECUTABLE_PATTERN = /\.(?:exe|cmd|bat|ps1)$/i;
const SUPPLEMENTAL_ASSET_PATTERN = /\.(?:asc|sig|sha256|sha256sum|sha512|sha512sum|checksums?|intoto\.jsonl|spdx\.json|sbom\.json|txt)$/i;
function normalizeChecksum(value) {
    const checksum = value.trim().toLowerCase().replace(/^sha256:/, "");
    if (!checksum) {
        return "";
    }
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
        throw new Error("checksum must be a SHA256 hex digest, optionally prefixed with sha256:");
    }
    return checksum;
}
function normalizeRename(value) {
    const rename = value.trim();
    if (!rename) {
        return "";
    }
    if (rename.includes("/") || rename.includes("\\") || rename !== path.basename(rename)) {
        throw new Error("rename must be a file name, not a path");
    }
    return rename;
}
function platformAliases(platform) {
    switch (platform) {
        case "linux":
            return ["linux"];
        case "darwin":
            return ["darwin", "macos", "mac-os", "mac_os", "osx", "apple-darwin"];
        case "win32":
            return ["windows", "win32", "win64", "pc-windows", "mingw"];
        default:
            throw new Error(`Unsupported runner platform: ${platform}`);
    }
}
function architectureAliases(arch) {
    switch (arch) {
        case "x64":
            return ["x86_64", "x64", "amd64"];
        case "arm64":
            return ["aarch64", "arm64"];
        default:
            return [arch.toLowerCase()];
    }
}
function includesAny(value, aliases) {
    return aliases.some((alias) => value.includes(alias));
}
function tarFlags(assetName) {
    const normalized = assetName.toLowerCase();
    if (normalized.endsWith(".tar.xz")) {
        return "xJ";
    }
    if (normalized.endsWith(".tar.bz2")) {
        return "xj";
    }
    return undefined;
}
function listFiles(root) {
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
        const directory = stack.pop();
        if (!directory) {
            continue;
        }
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
            }
            else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    }
    return files.sort();
}
function isLikelyExecutable(filePath) {
    if (os.platform() === "win32") {
        return WINDOWS_EXECUTABLE_PATTERN.test(filePath);
    }
    return (fs.statSync(filePath).mode & 0o111) !== 0;
}
function isArchive(assetName) {
    const normalized = assetName.toLowerCase();
    return normalized.endsWith(".zip") || TAR_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}
async function hashFile(filePath) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
}
function verifySha256(actualChecksum, expectedChecksum) {
    if (actualChecksum !== expectedChecksum) {
        throw new Error(`SHA256 mismatch. Expected ${expectedChecksum}, got ${actualChecksum}`);
    }
}
function chmodExecutable(filePath) {
    if (os.platform() !== "win32") {
        fs.chmodSync(filePath, 0o755);
    }
}
function moveFile(source, target) {
    try {
        fs.renameSync(source, target);
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EXDEV") {
            fs.copyFileSync(source, target);
            fs.rmSync(source);
            return;
        }
        throw error;
    }
}
function isMovingTag(tag) {
    return tag === "latest" || tag === "latest-prerelease";
}
function isSupplementalAsset(assetName) {
    return SUPPLEMENTAL_ASSET_PATTERN.test(assetName.toLowerCase());
}
function matchesGlob(value, pattern) {
    return globToRegExp(pattern).test(value);
}
function normalizePath(value) {
    return value.replace(/\\/g, "/").split(path.sep).join("/");
}
function relativeNames(root, files) {
    return files.map((file) => normalizePath(path.relative(root, file)));
}
function relativeMetadataPath(root, target) {
    const relativePath = normalizePath(path.relative(root, target));
    return relativePath || ".";
}
function formatNames(names) {
    return names.length === 0 ? "(none)" : names.join(", ");
}
function unique(values) {
    return [...new Set(values)];
}
function sanitizePathSegment(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}
function globToRegExp(pattern) {
    let source = "^";
    for (const character of pattern) {
        if (character === "*") {
            source += ".*";
        }
        else if (character === "?") {
            source += ".";
        }
        else {
            source += escapeRegExp(character);
        }
    }
    source += "$";
    return new RegExp(source, "i");
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const nativeRequire = createRequire(import.meta.url);
const requireMap = new Map();
const compatRequire = (specifier) => {
    if (requireMap.has(specifier)) {
        return requireMap.get(specifier);
    }
    return nativeRequire(specifier);
};
Object.assign(globalThis, { require: compatRequire });
let cache;
let core;
let tc;
const ACTION_NAME = "install-github-release-binary";
const CACHE_KEY_PREFIX = "ghrelbin";
const CACHE_SCHEMA_VERSION = "v4";
const INSTALL_METADATA_FILE = ".install-github-release-binary.json";
async function run() {
    try {
        await loadActionsToolkit();
        const inputs = getInputs();
        const release = await getRelease(inputs);
        const asset = selectAsset(release.assets, inputs);
        const cacheKey = getCacheKey(inputs, asset);
        const installRoot = getInstallRoot(inputs, asset);
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
        const metadata = {
            releaseTag: release.tag_name,
            assetId: asset.id,
            assetName: asset.name,
            assetSize: asset.size,
            assetUpdatedAt: asset.updated_at,
            installDir: installResult.installDir,
            binDirs: installResult.binDirs,
            binaryPaths: installResult.binaryPaths,
            checksum: actualChecksum,
        };
        writeInstallMetadata(installRoot, metadata);
        if (inputs.cacheEnabled && cacheKey) {
            await saveCache(installRoot, cacheKey);
        }
        const releaseDownloadUrl = materializeReleaseDownloadUrl(metadata, asset);
        addPaths(metadata.binDirs);
        setOutputs(metadata, false, releaseDownloadUrl);
        core.info(`Added ${formatNames(metadata.binDirs)} to PATH`);
    }
    catch (error) {
        if (core) {
            core.setFailed(error instanceof Error ? error.message : "Unexpected failure");
        }
        else {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        }
    }
}
async function loadActionsToolkit() {
    const [protobufRuntime, supportsColor] = await Promise.all([
        import('./chunks/protobuf-runtime.js').then(function (n) { return n.i; }),
        import('./chunks/vendor.js').then(function (n) { return n.A; }),
    ]);
    requireMap.set("@protobuf-ts/runtime", protobufRuntime);
    requireMap.set("supports-color", supportsColor.default);
    [cache, core, tc] = await Promise.all([
        import('./chunks/actions-cache.js'),
        import('./chunks/actions-shared.js').then(function (n) { return n.k; }),
        import('./chunks/actions-tool-cache.js'),
    ]);
}
function getInputs() {
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
function getBooleanInput(name) {
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
async function getRelease(inputs) {
    if (inputs.tag === "latest") {
        return githubJson(inputs, `/repos/${inputs.owner}/${inputs.repo}/releases/latest`);
    }
    if (inputs.tag === "latest-prerelease") {
        for (let page = 1;; page += 1) {
            const releases = await githubJson(inputs, `/repos/${inputs.owner}/${inputs.repo}/releases?per_page=100&page=${page}`);
            const release = releases.find((item) => item.prerelease && !item.draft);
            if (release) {
                return release;
            }
            if (releases.length < 100) {
                throw new Error("No prerelease found");
            }
        }
    }
    return githubJson(inputs, `/repos/${inputs.owner}/${inputs.repo}/releases/tags/${encodeURIComponent(inputs.tag)}`);
}
async function githubJson(inputs, pathname) {
    const response = await githubFetch(inputs.githubToken, `${githubApiBaseUrl()}${pathname}`, {
        accept: "application/vnd.github+json",
    });
    if (!response.ok) {
        throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
}
async function downloadAsset(asset, token) {
    const response = await githubFetch(token, asset.url, {
        accept: "application/octet-stream",
    });
    if (!response.ok) {
        throw new Error(`Asset download failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        throw new Error(`Asset download produced an empty response body: ${asset.name}`);
    }
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gh-release-asset-")), path.basename(asset.name));
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
    return filePath;
}
async function githubFetch(token, url, headers) {
    const requestHeaders = {
        Accept: headers.accept,
        "User-Agent": "install-github-release-binary-action",
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
function githubApiBaseUrl() {
    return process.env["GITHUB_API_URL"] || "https://api.github.com";
}
function selectAsset(assets, inputs) {
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
function autoSelectAssetMatches(assets) {
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
async function installAsset(assetPath, assetName, installRoot, inputs) {
    if (isArchive(assetName)) {
        await extractArchive(assetPath, assetName, installRoot);
        return installArchiveBinary(installRoot, inputs);
    }
    return installSingleBinary(assetPath, assetName, installRoot, inputs);
}
async function extractArchive(assetPath, assetName, destination) {
    fs.mkdirSync(destination, { recursive: true });
    if (assetName.toLowerCase().endsWith(".zip")) {
        await tc.extractZip(assetPath, destination);
        return;
    }
    await tc.extractTar(assetPath, destination, tarFlags(assetName));
}
function installArchiveBinary(installRoot, inputs) {
    const sources = selectInstalledBinaries(installRoot, inputs.binaryPattern);
    if (inputs.rename && sources.length !== 1) {
        throw new Error("rename is only supported when exactly one binary is installed");
    }
    const binaryPaths = sources.map((source) => {
        const target = inputs.rename ? path.join(path.dirname(source), inputs.rename) : source;
        if (path.resolve(source) !== path.resolve(target)) {
            if (fs.existsSync(target)) {
                throw new Error(`Cannot rename installed binary because target already exists: ${target}`);
            }
            fs.renameSync(source, target);
        }
        chmodExecutable(target);
        core.info(`Installed ${target}`);
        return target;
    });
    return {
        installDir: installRoot,
        binDirs: unique(binaryPaths.map((binaryPath) => path.dirname(binaryPath))),
        binaryPaths,
    };
}
function installSingleBinary(assetPath, assetName, installRoot, inputs) {
    fs.mkdirSync(installRoot, { recursive: true });
    const target = path.join(installRoot, inputs.rename || path.basename(assetName));
    moveFile(assetPath, target);
    chmodExecutable(target);
    core.info(`Installed ${target}`);
    return {
        installDir: installRoot,
        binDirs: [installRoot],
        binaryPaths: [target],
    };
}
function selectInstalledBinaries(installRoot, binaryPattern) {
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
function matchesBinaryPattern(installRoot, filePath, pattern) {
    const relativePath = normalizePath(path.relative(installRoot, filePath));
    const normalizedPattern = normalizePath(pattern);
    if (!normalizedPattern.includes("/")) {
        return matchesGlob(path.basename(relativePath), normalizedPattern);
    }
    return matchesGlob(relativePath, normalizedPattern);
}
function getInstallRoot(inputs, asset) {
    const baseDir = process.env["RUNNER_TOOL_CACHE"] || process.env["RUNNER_TEMP"] || os.tmpdir();
    return path.join(baseDir, ACTION_NAME, inputs.owner, inputs.repo, inputs.tag, String(asset.id), sanitizePathSegment(asset.name), sanitizePathSegment(inputs.checksum || asset.updated_at));
}
function getCacheKey(inputs, asset) {
    if (!inputs.cacheEnabled) {
        return undefined;
    }
    return [
        CACHE_KEY_PREFIX,
        CACHE_SCHEMA_VERSION,
        inputs.owner,
        inputs.repo,
        inputs.tag,
        `${os.platform()}-${os.arch()}`,
        String(asset.id),
        cacheFingerprint(inputs, asset),
    ].join("/");
}
function cacheFingerprint(inputs, asset) {
    const fingerprintSource = JSON.stringify({
        assetName: asset.name,
        assetSize: asset.size,
        assetUpdatedAt: asset.updated_at,
        checksum: inputs.checksum,
        binaryPattern: inputs.binaryPattern,
        rename: inputs.rename,
    });
    return crypto.createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 12);
}
async function saveCache(installRoot, cacheKey) {
    try {
        await cache.saveCache([installRoot], cacheKey);
        core.info(`Saved ${installRoot} to cache with key ${cacheKey}`);
    }
    catch (error) {
        const typedError = error;
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
function readInstallMetadata(installRoot, asset) {
    const metadataPath = path.join(installRoot, INSTALL_METADATA_FILE);
    if (!fs.existsSync(metadataPath)) {
        throw new Error(`Cached installation is missing metadata: ${metadataPath}`);
    }
    const storedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (!Array.isArray(storedMetadata.binDirs) || !Array.isArray(storedMetadata.binaryPaths)) {
        throw new Error(`Cached installation metadata is incompatible with ${CACHE_SCHEMA_VERSION}: ${metadataPath}`);
    }
    const metadata = {
        releaseTag: storedMetadata.releaseTag,
        assetId: storedMetadata.assetId,
        assetName: storedMetadata.assetName,
        assetSize: storedMetadata.assetSize,
        assetUpdatedAt: storedMetadata.assetUpdatedAt,
        installDir: installRoot,
        binDirs: storedMetadata.binDirs.map((binDir) => path.join(installRoot, binDir)),
        binaryPaths: storedMetadata.binaryPaths.map((binaryPath) => path.join(installRoot, binaryPath)),
        checksum: storedMetadata.checksum,
    };
    verifyCachedAssetMetadata(metadata, asset);
    for (const binaryPath of metadata.binaryPaths) {
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`Cached binary does not exist: ${binaryPath}`);
        }
    }
    return metadata;
}
function writeInstallMetadata(installRoot, metadata) {
    const storedMetadata = {
        releaseTag: metadata.releaseTag,
        assetId: metadata.assetId,
        assetName: metadata.assetName,
        assetSize: metadata.assetSize,
        assetUpdatedAt: metadata.assetUpdatedAt,
        binDirs: metadata.binDirs.map((binDir) => relativeMetadataPath(installRoot, binDir)),
        binaryPaths: metadata.binaryPaths.map((binaryPath) => relativeMetadataPath(installRoot, binaryPath)),
        checksum: metadata.checksum,
    };
    fs.writeFileSync(path.join(installRoot, INSTALL_METADATA_FILE), `${JSON.stringify(storedMetadata, null, 2)}\n`);
}
function materializeReleaseDownloadUrl(metadata, asset) {
    if (isArchive(asset.name) || metadata.binaryPaths.length !== 1) {
        return "";
    }
    const source = metadata.binaryPaths[0];
    if (!source) {
        return "";
    }
    const downloadRoot = path.join(metadata.installDir, ".release-download");
    const target = path.join(downloadRoot, metadata.releaseTag, asset.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    try {
        fs.linkSync(source, target);
        core.info(`Created release download layout with hardlink: ${target} -> ${source}`);
    }
    catch (hardlinkError) {
        try {
            fs.symlinkSync(source, target);
            core.info(`Created release download layout with symlink: ${target} -> ${source}`);
        }
        catch (symlinkError) {
            const hardlinkMessage = hardlinkError instanceof Error ? hardlinkError.message : String(hardlinkError);
            const symlinkMessage = symlinkError instanceof Error ? symlinkError.message : String(symlinkError);
            core.warning(`Could not create release download layout: hardlink failed: ${hardlinkMessage}; symlink failed: ${symlinkMessage}`);
            return "";
        }
    }
    return pathToFileURL(downloadRoot).href;
}
function verifyCachedAssetMetadata(metadata, asset) {
    if (metadata.assetId !== asset.id ||
        metadata.assetName !== asset.name ||
        metadata.assetSize !== asset.size ||
        metadata.assetUpdatedAt !== asset.updated_at) {
        throw new Error("Cached installation metadata does not match the selected GitHub release asset");
    }
}
function setOutputs(metadata, cacheHit, releaseDownloadUrl) {
    core.setOutput("release-tag", metadata.releaseTag);
    core.setOutput("asset-name", metadata.assetName);
    core.setOutput("install-dir", metadata.installDir);
    core.setOutput("bin-dir", metadata.binDirs[0] || "");
    core.setOutput("binary-path", metadata.binaryPaths[0] || "");
    core.setOutput("bin-dirs", JSON.stringify(metadata.binDirs));
    core.setOutput("binary-paths", JSON.stringify(metadata.binaryPaths));
    core.setOutput("checksum", metadata.checksum);
    core.setOutput("cache-hit", cacheHit ? "true" : "false");
    core.setOutput("release-download-url", releaseDownloadUrl);
}
function addPaths(binDirs) {
    for (const binDir of binDirs) {
        core.addPath(binDir);
    }
}
void run();
