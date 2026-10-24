{{- /* riscv nodes don't use Image Factory: their installer is set in all/cluster-1.yaml.tpl */ -}}
{{- if eq .Node.Data.hw "rk1" }}
overlay:
  image: siderolabs/sbc-rockchip
  name: turingrk1
{{- end }}
customization:
  systemExtensions:
    officialExtensions:
      # Longhorn
      - siderolabs/iscsi-tools
      - siderolabs/util-linux-tools
