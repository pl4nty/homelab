FROM ghcr.io/rocker-org/shiny-verse:4.6.1@sha256:7eac2fc7e0550b7a048f6f0aa9c9c3ce8af21ae45e96b8bc623f2098c1ceb869
WORKDIR /srv/shiny-server

RUN rm -r ./*
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt update && apt-get --no-install-recommends install -y \
  libglpk-dev libudunits2-dev libnetcdf-dev libproj-dev libgdal-dev libmagick++-dev libstdc++6

RUN mv /usr/local/lib/R/site-library /usr/local/lib/R/site-library-2
COPY --from=src auto_install_load.R .
# devtools 2.5 dropped remotes, which install_github still needs
RUN --mount=type=cache,target=/usr/local/lib/R/site-library cp -r /usr/local/lib/R/site-library-2/* /usr/local/lib/R/site-library \
&& Rscript -e 'install.packages("remotes")' \
&& Rscript auto_install_load.R && cp -r /usr/local/lib/R/site-library/* /usr/local/lib/R/site-library-2
# shiny user can't write to /usr/local/lib/R/site-library
RUN mv /usr/local/lib/R/site-library-2 /usr/local/lib/R/site-library && usermod -a -G staff shiny

COPY --from=src . .
RUN sed -i 's|source.*||g' ui.R
