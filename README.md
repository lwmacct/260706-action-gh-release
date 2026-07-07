# Install GitHub Release Binary

从 GitHub Release 下载二进制发布产物，自动选择当前 runner 对应的 asset，必要时解压，选择可执行文件，并把它加入 `PATH`。

这个 Action 适合安装 release 中发布的 CLI 工具，例如 `upx/upx`、`sharkdp/fd`、`BurntSushi/ripgrep` 这类项目。

## 特性

- 支持 `latest`、`latest-prerelease` 和固定 tag
- 默认按当前 runner 的系统和架构自动选择 release asset
- 支持用 glob 显式选择 asset
- 自动识别 `.zip`、`.tar.gz`、`.tar.xz`、`.tar.bz2`、`.tgz`
- 对 archive 自动解压，并将匹配到的 binary 所在目录加入 `PATH`
- 支持 SHA256 校验
- 支持固定 tag 缓存；未提供 checksum 时使用 GitHub asset metadata 作为缓存锚点
- 输出安装路径、asset 名称、实际 SHA256 和 cache 命中状态
- 缓存原始 release asset 和安装后的 binary
- 输出本地 GitHub Release 下载根地址，方便其他工具复用缓存

## 基本用法

```yaml
steps:
  - uses: actions/checkout@v5

  - uses: lwmacct/260706-action-gh-release@main
    with:
      repository: upx/upx
      tag: v5.2.0
      binary: upx

  - run: upx --version
```

## 自动选择 asset

如果不传 `asset`，Action 会根据当前 runner 的系统和架构匹配 release asset 名称。

支持的常见别名包括：

- Linux: `linux`
- macOS: `darwin`、`macos`、`osx`
- Windows: `windows`、`win32`、`win64`
- x64: `x86_64`、`x64`、`amd64`
- arm64: `aarch64`、`arm64`

如果自动匹配到多个 asset，Action 会失败并打印候选列表。此时应显式指定 `asset`。

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
    asset: "*linux*amd64*.tar.gz"
    binary: tool
```

## 选择 binary

`binary` 只用于选择最终安装的可执行文件，可以匹配一个或多个文件。

对于裸二进制 asset，可以不传 `binary`：

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
```

对于 archive，可以传入 binary 名称或 archive 内路径：

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
    binary: "bin/tool"
```

也可以匹配多个 binary：

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
    binary: "bin/*"
```

如果不传 `binary`，Action 会选择 archive 内所有看起来可执行的文件，并将它们的父目录加入 `PATH`。如果 archive 内没有可执行文件，但只有一个普通文件，则会安装这个文件。

## 缓存

启用缓存：

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
    binary: tool
    cache: "true"
```

缓存规则：

- `latest` 和 `latest-prerelease` 是移动 tag，不会缓存
- 固定 tag 可以缓存
- cache key 格式为 `gh-release/v1/<owner>/<repo>/<tag>/<platform>-<arch>/<fingerprint>`
- cache fingerprint 包含 GitHub asset metadata：`asset.id`、`asset.name`、`asset.size`、`asset.updated_at`
- 如果提供 `checksum`，cache fingerprint 也会包含 checksum
- cache 内容使用 `asset/`、`bin/`、`release/` 和 `metadata.json` 布局
- cache hit 后会校验缓存 metadata 是否仍匹配当前选中的 release asset

## SHA256 校验

`checksum` 是可选的。提供后，下载的 release asset 必须匹配该 SHA256。

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
    binary: tool
    checksum: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

也可以传裸 hex：

```yaml
checksum: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

无论是否传入 `checksum`，Action 都会计算下载文件的实际 SHA256，并通过 output `checksum` 暴露。

## 重命名 binary

`rename` 只支持文件名，不支持路径。

```yaml
- uses: lwmacct/260706-action-gh-release@main
  with:
    repository: owner/tool
    tag: v1.2.3
    binary: original-name
    rename: tool
```

如果匹配到多个 binary，`rename` 会失败。需要重命名单个文件时，请让 `binary` 只匹配一个文件。

## Inputs

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `repository` | 是 |  | GitHub 仓库，格式为 `owner/repo` |
| `tag` | 否 | `latest` | Release tag。可用 `latest`、`latest-prerelease` 或固定 tag |
| `github-token` | 否 | `${{ github.token }}` | 读取 release metadata 和下载 asset 使用的 GitHub token |
| `asset` | 否 |  | 用于选择 release asset 的 glob。省略时按当前 OS/arch 自动匹配 |
| `binary` | 否 |  | 用于选择最终安装 binary 的 glob。archive 场景下可匹配一个或多个解压后的文件 |
| `checksum` | 否 |  | 可选 SHA256，支持 `sha256:<hex>` 或裸 hex |
| `cache` | 否 | `false` | 设为 `true` 后对固定 tag 启用缓存 |
| `rename` | 否 |  | 重命名最终安装的单个 binary |

## Outputs

| 名称 | 说明 |
| --- | --- |
| `release-tag` | 解析后的 release tag |
| `asset-name` | 选中的 release asset 名称 |
| `install-dir` | 安装目录 |
| `asset-path` | 缓存中的原始 release asset 路径 |
| `bin-dir` | 第一个已加入 `PATH` 的目录 |
| `binary-path` | 第一个最终安装的 binary 路径 |
| `bin-dirs` | JSON 数组，包含所有已加入 `PATH` 的目录 |
| `binary-paths` | JSON 数组，包含所有最终安装的 binary 路径 |
| `checksum` | 下载 asset 的实际 SHA256 |
| `cache-hit` | 是否命中缓存，值为 `true` 或 `false` |
| `release-download-url` | 本地 `file://` Release 下载根地址 |

## 本地 Release 下载地址

Action 会在安装目录中创建一个 GitHub Release 下载布局，并输出 `release-download-url`：

```text
<install-dir>/release/<release-tag>/<asset-name>
```

这个输出适合传给支持覆盖 GitHub Release 下载根地址的工具。例如 `appleboy/ssh-action` 会把 `DRONE_SSH_RELEASE_URL` 拼成：

```text
${DRONE_SSH_RELEASE_URL}/v1.8.2/drone-ssh-1.8.2-linux-amd64
```

可这样复用已缓存的 `drone-ssh`：

```yaml
- id: drone-ssh
  uses: lwmacct/260706-action-gh-release@main
  with:
    repository: appleboy/drone-ssh
    tag: v1.8.2
    asset: drone-ssh-1.8.2-linux-amd64
    cache: "true"

- uses: appleboy/ssh-action@v1.2.5
  env:
    DRONE_SSH_RELEASE_URL: ${{ steps.drone-ssh.outputs.release-download-url }}
```

缓存目录结构如下：

```text
<install-dir>/
  asset/
    <asset-name>
  bin/
    <installed-binaries>
  release/
    <release-tag>/
      <asset-name>
  metadata.json
```

`release/<release-tag>/<asset-name>` 优先 hardlink 到 `asset/<asset-name>`，失败时使用 symlink，不复制文件内容。裸二进制 asset 安装到 `bin/` 时优先 hardlink，失败后依次使用 symlink 和 copy，并会在日志中输出实际模式。

## 完整示例：安装 UPX

```yaml
name: Test UPX

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  install-upx:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v5

      - name: Install UPX
        uses: lwmacct/260706-action-gh-release@main
        with:
          repository: upx/upx
          tag: v5.2.0
          binary: upx
          cache: "true"

      - run: |
          command -v upx
          upx --version
```

## 行为说明

- 非 Windows runner 上，最终 binary 会被设置为 `755`
- `asset` 和 `binary` 使用简单 glob，支持 `*` 和 `?`
- archive 中有多个可执行文件时，如果不设置 `binary`，会全部安装并暴露到 `PATH`
- `latest-prerelease` 会选择最新的非 draft prerelease
- 私有仓库或更高 API rate limit 场景下，请传入有权限的 `github-token`
