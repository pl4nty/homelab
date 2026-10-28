# mount mdm.xml to /var/lib/cloudflare-warp/mdm.xml
FROM debian:12

RUN curl https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
&& echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list \
&& apt-get update \
&& sudo apt-get install cloudflare-warp=2023.7.40-1 \
&& rm -rf /var/lib/apt/lists/*

ENTRYPOINT [ "/bin/warp-svc" ]
