{{- $hw := .Node.Data.hw }}
{{- $cp := eq .Node.Role "control-plane" }}
{{- $logs := printf "tcp://%s:30544" (urlParse .ClusterEndpoint).hostname }}
machine:
  install:
{{- if eq $hw "rk1" }}
    diskSelector:
      size: <= 100GB
{{- else }}
    disk: {{ index .Node.Data "disk" | default "/dev/nvme0n1" }}
{{- end }}
{{- with index .Node.Data "installer" }}
    image: {{ . }}
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
  nodeTaints:
    kubernetes.io/arch: riscv64:NoSchedule
{{- end }}
  logging:
    destinations:
      - endpoint: {{ $logs }}
        format: json_lines
  kubelet:
{{- with index .Node.Data "kubeletImage" }}
    image: {{ . }}
{{- end }}
    extraArgs:
      rotate-server-certificates: "true"
    extraMounts:
      - destination: /var/lib/longhorn
        type: bind
        source: /var/lib/longhorn
        options: [bind, rshared, rw]
{{- if $cp }}
    # etcd isn't in kubelet accounting. systemReserved replaces all talos defaults, so keep the other keys
    extraConfig:
      systemReserved:
        cpu: 50m
        memory: 1Gi
        pid: "100"
        ephemeral-storage: 256Mi
{{- end }}
  sysctls:
    # rk1: 512Mi for cnpg. none on the 8GiB nuc, where they starved etcd
    vm.nr_hugepages: "{{ if eq $hw "rk1" }}256{{ else }}0{{ end }}"
{{- if $cp }}
cluster:
  allowSchedulingOnControlPlanes: true
{{- end }}
