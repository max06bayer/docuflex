#!/bin/sh
set -eu

output_format=""
output_directory=""
input_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --headless)
      shift
      ;;
    --convert-to)
      output_format="${2%%:*}"
      shift 2
      ;;
    --outdir)
      output_directory="$2"
      shift 2
      ;;
    *)
      input_path="$1"
      shift
      ;;
  esac
done

if [ "$output_format" != "doc" ] || [ -z "$output_directory" ] || [ -z "$input_path" ]; then
  echo "The bundled converter only supports the PDF-to-DOC finishing step." >&2
  exit 2
fi

input_name=${input_path##*/}
base_name=${input_name%.*}
/usr/bin/textutil -convert doc -output "$output_directory/$base_name.doc" "$input_path"
