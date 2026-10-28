{{- if eq .Node.Data.hw "rk1" }}
overlay:
  image: siderolabs/sbc-rockchip
  name: turingrk1
{{- end }}
customization:
  systemExtensions:
    officialExtensions:
      - siderolabs/iscsi-tools
      - siderolabs/util-linux-tools
