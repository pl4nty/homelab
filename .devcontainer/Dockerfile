FROM mcr.microsoft.com/devcontainers/base:bookworm
ARG TARGETOS TARGETARCH

USER vscode

# https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm#InstallingCLI__linux_and_unix
RUN bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults

RUN curl -L https://github.com/siderolabs/talos/releases/latest/download/talosctl-$TARGETOS-$TARGETARCH -o ~/bin/talosctl \
  && chmod +x ~/bin/talosctl \
  && echo "source <(talosctl completion zsh)" >> ~/.zshrc

RUN curl -s -L https://github.com/backube/volsync/releases/latest/download/kubectl-volsync.tar.gz | tar -xzf - -C ~/bin kubectl-volsync

# https://github.com/ohmyzsh/ohmyzsh/tree/master/plugins
RUN echo "plugins+=(azure fluxcd kubectl helm)" >> ~/.zshrc

RUN echo "source \$ZSH/oh-my-zsh.sh" >> ~/.zshrc
