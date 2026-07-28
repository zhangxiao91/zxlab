$root = Join-Path $PSScriptRoot "大学资料"
$folders = @(
  "00_收件箱",
  "01_课程\2026-2027-1\高等数学\课件",
  "01_课程\2026-2027-1\高等数学\作业",
  "01_课程\2026-2027-1\高等数学\复习",
  "01_课程\2026-2027-1\大学英语",
  "01_课程\2026-2027-2",
  "02_证件与手续",
  "03_项目与比赛",
  "04_个人作品",
  "05_软件与安装包",
  "99_归档"
)

foreach ($folder in $folders) {
  New-Item -ItemType Directory -Path (Join-Path $root $folder) -Force | Out-Null
}

Write-Host "已创建大学资料目录：" $root
