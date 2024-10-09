FROM mcr.microsoft.com/devcontainers/base:bookworm
ARG TARGETOS TARGETARCH

USER vscode

# https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm#InstallingCLI__linux_and_unix
RUN bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults

RUN curl -L https://github.com/siderolabs/talos/releases/latest/download/talosctl-$TARGETOS-$TARGETARCH -o ~/bin/talosctl \
  && chmod +x ~/bin/talosctl \
  && echo "source <(talosctl completion zsh)" >> ~/.zshrc

RUN curl -s -L https://github.com/backube/volsync/releases/latest/download/kubectl-volsync.tar.gz | tar -xzf - -C ~/bin kubectl-volsync

RUN curl -s -L https://github.com/kubecolor/kubecolor/releases/download/v0.3.0/kubecolor_0.3.0_linux_amd64.tar.gz | tar -xzf - -C ~/bin kubecolor

RUN curl -s -L https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.23.2/kubectl-cnpg_1.23.2_linux_x86_64.deb \
  && dpkg -i kubectl-cnpg_1.23.2_linux_x86_64.deb

# https://github.com/ohmyzsh/ohmyzsh/tree/master/plugins
RUN printf "plugins+=(azure fluxcd kubectl helm) \n\
source <(kubectl completion zsh) \n\
alias kubectl=kubecolor \n\
compdef kubecolor=kubectl \n\
source $ZSH/oh-my-zsh.sh" >> ~/.zshrc

ENV KUBE_EDITOR="code --wait"
