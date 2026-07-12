# zxdrop

zxdrop 是 zxlab 的轻量跨设备临时文件传输工具。当前代码完成开发计划的阶段 1：本地单页面原型。

## 已实现

- 从 `ClipboardEvent` 直接读取粘贴的截图，无需先保存到磁盘
- 点击选择和拖放文件
- 图片预览、文件名、类型和大小
- 单文件 20 MB、单次 10 个文件、总计 50 MB 的前端校验
- IndexedDB 本地文件与最近传输记录
- 发送进度与移动端接收视图
- Web Share API 文件分享，不支持时自动回退到下载
- Vite PWA manifest 与离线应用壳
- 桌面和移动端响应式布局

当前“发送”流程是用于验证产品体验的本地闭环。它不会上传文件，也不会声称已完成真实设备配对、端到端加密或云端传输。

## 本地开发

在仓库根目录运行：

```bash
npm install
npm run dev --workspace zxdrop
```

默认地址为 `http://localhost:4173`。

```bash
npm test --workspace zxdrop
npm run build:zxdrop
```

也可以使用 pnpm：

```bash
pnpm install
pnpm --filter zxdrop dev
```

## 数据存储

阶段 1 使用名为 `zxdrop-local` 的 IndexedDB 数据库，`transfers` object store 保存文件 Blob 和必要的本地元数据。清除站点数据会删除这些记录。服务端尚未参与。

## 后续阶段边界

后续应按产品需求依次增加：

1. `packages/protocol` 与设备身份、二维码配对
2. 独立 `apps/worker`、每设备一个 Durable Object 和 R2 临时密文
3. `packages/crypto` 中的 AES-256-GCM 文件加密及公钥封装
4. 完整 PWA 安装体验、Cloudflare Pages/Workers 部署与 zxlab 主站入口

Worker 必须独立部署，主站只提供介绍和跳转，不承载实时通信或文件存储。

## 浏览器限制

- Web 页面不能在后台持续监听系统剪贴板；用户通常需要切换到 zxdrop 页面后执行粘贴。
- 网页无法绕过系统分享面板直接发送给指定微信好友。分享目标由手机系统和已安装应用决定。
- 不支持 Web Share API 文件分享时，zxdrop 会回退到下载。
- iOS 和 Android 对 PWA、后台 WebSocket 和文件分享能力的支持存在差异。
- Clipboard API 和 Web Share API 通常要求 HTTPS 或 localhost 安全上下文。

## 隐私说明

阶段 1 文件只保存在当前浏览器的 IndexedDB 中，不会离开设备。后续云端版本必须在浏览器内加密文件，服务端不得保存文件明文、文件密钥明文、设备私钥、剪贴板内容或长期传输历史。

## zxlab 接入文案

- 产品标题：zxdrop
- 一句话介绍：把刚截的图，快速送到另一台设备。
- 简介：zxdrop 是 zxlab 的跨设备临时传输工具。粘贴截图或拖入文件，即可安全送往已配对设备；无需账号、网盘或完整客户端，文件领取后自动销毁。
- 图标建议：蓝色圆角方形内的极简断开式字母 z，同时表达发送路径。
- Open Graph 标题：`zxdrop — 跨设备临时传输`
- Open Graph 描述：`把刚截的图，快速送到另一台设备。`
