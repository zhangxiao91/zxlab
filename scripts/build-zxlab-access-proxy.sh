#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
output_path=${1:-"${script_dir}/.bin/zxlab-access-proxy"}
output_dir=${output_path:h}
module_cache_dir=${TMPDIR:-/tmp}/zxlab-access-proxy-module-cache
mkdir -p "${output_dir}"
mkdir -p "${module_cache_dir}"

staging_path=$(mktemp "${output_dir}/zxlab-access-proxy.XXXXXX")
trap 'rm -f "${staging_path}"' EXIT

xcrun clang \
  -fobjc-arc \
  -fblocks \
  -Wall \
  -Wextra \
  -Werror \
  -Wno-deprecated-declarations \
  -fmodules-cache-path="${module_cache_dir}" \
  -O \
  -framework Foundation \
  -framework Security \
  -framework CFNetwork \
  "${script_dir}/zxlab-access-proxy.m" \
  -o "${staging_path}"

/usr/bin/codesign \
  --force \
  --sign - \
  --options runtime \
  --identifier dev.zxlab.debug-access-proxy \
  "${staging_path}"

chmod 700 "${staging_path}"
mv -f "${staging_path}" "${output_path}"
trap - EXIT

print "Installed ZXLab Access proxy at ${output_path}"
