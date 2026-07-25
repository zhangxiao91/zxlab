---
title: "Hello World"
description: "运行第一个最小程序，认识代码、输入、输出、报错和重新运行。"
routeId: "coding"
status: "open"
updatedAt: 2026-07-25
tags:
  - 编程入门
  - Hello World
  - JavaScript
---

# Hello World

“Hello World”不是为了学会一门语言，而是确认一条最小链路：你写下代码，运行环境读取它，屏幕出现结果。

## 不安装软件的运行方法

使用浏览器打开任意普通页面，按 `F12`（部分电脑需要 `Fn + F12`）打开开发者工具，选择 Console。看到安全警告时不要粘贴陌生人给你的代码。

自己输入：

```js
console.log("Hello, World!");
```

按 Enter。如果控制台显示 `Hello, World!`，第一个程序就运行成功了。

## 改成自己的内容

```js
const name = "小明";
console.log(`你好，${name}！`);
```

这里：

- `const name` 创建了一个名为 `name` 的变量。
- `"小明"` 是保存在变量里的文本。
- `console.log` 把结果输出到控制台。

修改名字并重新运行，观察输出变化。

## 主动制造一个报错

把 `console.log` 写成：

```js
console.lgo("Hello");
```

运行后会出现错误。编程中的报错不是失败通知，而是定位问题的线索。先看错误类型和行号，再比较拼写；修正为 `console.log` 后重新运行。

## 保存为真正的文件

新建一个名为 `hello.html` 的文本文件，写入：

```html
<!doctype html>
<html lang="zh-CN">
  <meta charset="utf-8" />
  <title>Hello World</title>
  <h1>Hello, World!</h1>
</html>
```

确认真实后缀是 `.html`，不是 `.html.txt`。双击文件后，浏览器应显示标题。改字、保存、刷新页面，观察结果。

## 完成标准

- 亲手输入并运行了一行代码。
- 修改变量后看到了不同输出。
- 读过一次报错并修正它。
- 保存并打开了一个 `.html` 文件。

下一步进入[命令行基础](/lab/digital-starter/docs/command-line)，从终端找到这个文件。
