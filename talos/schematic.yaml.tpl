{{- if eq .Node.Role "worker" }}
# workers are Turing RK1 (RK3588)
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
