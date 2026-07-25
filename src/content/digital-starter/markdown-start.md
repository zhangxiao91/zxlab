---
title: "Markdown 入门"
description: "从写一份清晰文档开始，体验文本、预览和版本管理。"
routeId: "coding"
status: "open"
updatedAt: 2026-07-25
tags:
  - Markdown
  - 编程入门
  - 文档
---

# Markdown 入门

Markdown 是一种用普通文本表示结构的写法。文件通常以 `.md` 结尾，可以在记事本、VS Code、GitHub 和许多笔记工具中打开。

## 先认识几个语法

````md
# 一级标题

## 二级标题

- 列表项目
- 另一个项目

[链接文字](https://example.com)

**加粗文字**

`行内代码`

```js
console.log("Hello, World!");
```
````

标题的 `#` 后面要留一个空格。列表项使用 `-` 加空格。空一行可以清楚地分隔段落。

## 写一份最小 README

在一个练习文件夹中新建 `README.md`：

```md
# 我的第一个项目

这是一个用来练习 Markdown 和 GitHub 的项目。

## 我完成了什么

- 运行 Hello World
- 使用命令行查看目录
- 写下这份说明

## 下一步

- 把文件保存到 GitHub
```

保存后使用编辑器的 Markdown 预览功能，检查标题、列表和代码块是否正确。

## 图片和相对路径

```md
![图片说明](images/example.png)
```

`images/example.png` 是相对当前文档的位置。移动图片或文档后，链接可能失效。文件名尽量使用清楚的英文、数字和短横线，避免在技术项目中混入难以处理的特殊字符。

## Markdown 不负责什么

- 它不是 Word，不能保证每台设备上都有完全相同的分页和字体。
- 改成 `.md` 后缀不会把 Word 文档自动转换成 Markdown。
- 预览正常不代表链接和事实正确，提交前仍要检查内容。

## 完成标准

- 创建一个 `README.md`。
- 使用标题、段落、列表、链接和代码块。
- 在预览中确认格式正常。
- 用命令行或文件资源管理器找到它的准确位置。

完成后进入 [GitHub 基础](/lab/digital-starter/docs/github-basics)，把这份 README 放进第一个仓库。
