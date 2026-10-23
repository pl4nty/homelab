# Only non-default settings. Role-specific blocks are templated, so that the whole
# cluster is one patch. Workers are all Turing RK1: OS on eMMC, data on NVMe.
{{- $cp := eq .Node.Role "control-plane" }}
{{- $logs := ternary "tcp://k8s-monitoring-alloy-logs.monitoring-system.svc:5044/" "tcp://192.168.1.131:30544" $cp }}
machine:
  install:
{{- if $cp }}
    disk: /dev/nvme0n1
{{- else }}
    diskSelector:
      size: <= 100GB
{{- end }}
    extraKernelArgs:
      - talos.logging.kernel={{ $logs }}
{{- if not $cp }}
  disks:
    - device: /dev/nvme0n1
      partitions:
        - mountpoint: /var/mnt/nvme0n1
{{- end }}
  logging:
    destinations:
      - endpoint: {{ $logs }}
        format: json_lines
  kubelet:
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
{{- if $cp }}
    # no hugepages on the control plane: they're unswappable and starved etcd/apiserver
    # (mayastor, which needed them, is archived; cnpg pods schedule on workers)
    vm.nr_hugepages: "0"
{{- else }}
    # 512Mi for cnpg pods (100Mi hugepages-2Mi each), previously 3Gi for mayastor (archived)
    vm.nr_hugepages: "256"
{{- end }}
{{- if $cp }}
cluster:
  allowSchedulingOnControlPlanes: true
{{- end }}
