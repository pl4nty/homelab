# Only non-default settings. Hardware-specific blocks are keyed on .Node.Data.hw
# (see topf.yaml), role-specific blocks on .Node.Role, so a node can change role
# without changing hardware config.
{{- $hw := .Node.Data.hw }}
{{- $cp := eq .Node.Role "control-plane" }}
{{- /* kernel logs ship before cluster DNS is up, so non-CP nodes use the alloy NodePort on the cluster endpoint */ -}}
{{- $logs := printf "tcp://%s:30544" (urlParse .ClusterEndpoint).hostname }}
{{- if $cp }}{{ $logs = "tcp://k8s-monitoring-alloy-logs.monitoring-system.svc:5044/" }}{{ end }}
machine:
  install:
{{- if eq $hw "nuc" }}
    disk: /dev/nvme0n1
{{- else if eq $hw "rk1" }}
    diskSelector:
      size: <= 100GB
{{- else if eq $hw "riscv" }}
{{- if not (and (hasKey .Node.Data "installer") (hasKey .Node.Data "installDisk")) }}{{ fail "riscv nodes need data.installer and data.installDisk" }}{{ end }}
    image: {{ .Node.Data.installer }}
    disk: {{ .Node.Data.installDisk }}
{{- else }}{{ fail (printf "%s: unknown data.hw %q" .Node.Host $hw) }}
{{- end }}
    extraKernelArgs:
      - talos.logging.kernel={{ $logs }}
{{- if eq $hw "rk1" }}
  disks:
    - device: /dev/nvme0n1
      partitions:
        - mountpoint: /var/mnt/nvme0n1
{{- end }}
{{- if eq $hw "riscv" }}
  # most images have no riscv64 build
  nodeTaints:
    kubernetes.io/arch: riscv64:NoSchedule
{{- end }}
  logging:
    destinations:
      - endpoint: {{ $logs }}
        format: json_lines
  kubelet:
{{- if hasKey .Node.Data "kubeletImage" }}
    image: {{ .Node.Data.kubeletImage }}
{{- end }}
    extraArgs:
      rotate-server-certificates: "true"
    extraMounts:
      - destination: /var/lib/longhorn
        type: bind
        source: /var/lib/longhorn
        options:
          - bind
          - rshared
          - rw
{{- if $cp }}
    # etcd runs outside kubelet accounting, so reserve more for it (talos default 512Mi).
    # setting systemReserved replaces all of talos' defaults, so keep the other keys
    extraConfig:
      systemReserved:
        cpu: 50m
        memory: 1Gi
        pid: "100"
        ephemeral-storage: 256Mi
{{- end }}
  sysctls:
{{- if eq $hw "rk1" }}
    # 512Mi for cnpg pods (100Mi hugepages-2Mi each), previously 3Gi for mayastor (archived)
    vm.nr_hugepages: "256"
{{- else }}
    # none on the 8GiB nuc (they're unswappable and starved etcd/apiserver) or riscv boards
    vm.nr_hugepages: "0"
{{- end }}
{{- if $cp }}
cluster:
  allowSchedulingOnControlPlanes: true
{{- end }}
