FROM mcr.microsoft.com/devcontainers/base:bookworm@sha256:06701e75787b0b948709e803f95b42cabf37607b1c308c57471d6f0252149d87
ARG TARGETOS TARGETARCH

USER vscode

# https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm#InstallingCLI__linux_and_unix
RUN bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults

RUN curl -L https://github.com/siderolabs/talos/releases/latest/download/talosctl-$TARGETOS-$TARGETARCH -o ~/bin/talosctl \
  && chmod +x ~/bin/talosctl \
  && echo "source <(talosctl completion zsh)" >> ~/.zshrc

RUN curl -s -L https://github.com/postfinance/topf/releases/latest/download/topf_${TARGETOS}_${TARGETARCH}.tar.gz | tar -xzf - -C ~/bin topf

RUN curl -s -L https://github.com/backube/volsync/releases/latest/download/kubectl-volsync-linux-amd64.tar.gz | tar -xzf - -C ~/bin kubectl-volsync

RUN curl -s -L https://github.com/kubecolor/kubecolor/releases/download/v0.5.3/kubecolor_0.5.3_linux_amd64.deb -o ~/kubecolor.deb \
  && sudo dpkg -i ~/kubecolor.deb \
  && rm ~/kubecolor.deb

RUN curl -L https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.28.1/kubectl-cnpg_1.28.1_linux_x86_64.deb -o ~/kubectl-cnpg.deb \
  && sudo dpkg -i ~/kubectl-cnpg.deb \
  && rm ~/kubectl-cnpg.deb

# https://github.com/ohmyzsh/ohmyzsh/tree/master/plugins
RUN printf "plugins+=(azure fluxcd kubectl helm) \n\
source <(kubectl completion zsh) \n\
source <(kubectl cnpg completion zsh) \n\
alias kubectl=kubecolor \n\
compdef kubecolor=kubectl \n\
source \$ZSH/oh-my-zsh.sh" >> ~/.zshrc
