---
title: "GitHub 基础"
description: "认识仓库、提交和远程副本，把一份 README 放进自己的第一个 GitHub 仓库。"
routeId: "coding"
status: "open"
updatedAt: 2026-07-28
tags:
  - 编程入门
  - GitHub
  - Git
  - 仓库
---

# GitHub 基础

Git 用来记录文件变化，GitHub 用来托管 Git 仓库并协作。GitHub 不是普通网盘：一次提交应该说明“这批相关改动做了什么”。

## 先认识四个词

- **仓库 Repository**：项目文件和历史记录的集合。
- **提交 Commit**：一组有说明的变化快照。
- **分支 Branch**：一条独立的修改线路。
- **远程 Remote**：托管在 GitHub 等平台上的仓库副本。

## 用网页完成第一个仓库

1. 登录 GitHub，开启两步验证，并妥善保存恢复方式。
2. 新建仓库，例如 `digital-starter-practice`。
3. 选择添加 README，或创建后上传自己的 `README.md`。
4. 填写提交说明，例如 `docs: add first README`。
5. 打开文件历史，确认能看到刚才的提交。

仓库公开前，检查文件中有没有姓名学号、邮箱、课程内部资料、密码、令牌或不应公开的作品。

## 提交说明怎么写

不要只写 `update` 或 `改一下`。用动词说明目的：

```txt
docs: add project introduction
fix: correct broken image path
feat: add hello world page
```

一次提交尽量只包含同一件事，方便以后理解、撤销和协作。

## 用 GitHub Desktop 连接本地文件

不想马上记命令时，可以使用 GitHub Desktop：

1. 从官网下载安装并登录。
2. Clone 刚创建的仓库到一个明确的本地目录。
3. 把 `hello.html` 和 `README.md` 放进去。
4. 查看 Changes，确认没有隐私文件。
5. 写提交说明并 Commit。
6. Push 到 GitHub，刷新网页确认文件出现。

提交前始终先看变化清单，不要把下载目录、环境变量文件、账号凭证或无关的大文件一起上传。

## 仓库不是备份的全部

GitHub 能保存代码和文档历史，但账号可能丢失，私有内容也有权限风险。重要项目仍要保留本地副本，并设置可靠的账号恢复方式。

## 完成标准

- 创建一个仓库并能解释公开与私有的区别。
- 仓库中有 `README.md` 和 `hello.html`。
- 至少完成一次有明确说明的提交。
- 在网页上确认远程仓库出现最新文件。
- 提交前检查过隐私和凭证。

到这里，最小链路已经闭环：运行代码、使用命令行找到文件、用 Markdown 说明项目、在 GitHub 保存历史。AI Coding 暂时保留为下一阶段。
