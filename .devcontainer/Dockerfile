FROM mcr.microsoft.com/devcontainers/base:bookworm

USER vscode

# https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm#InstallingCLI__linux_and_unix
RUN bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults

# https://github.com/siderolabs/talos/releases
RUN curl https://github.com/siderolabs/talos/releases/latest/download/talosctl-$TARGETOS-$TARGETARCH -o ~/bin/talosctl && chmod +x ~/bin/talosctl
