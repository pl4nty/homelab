FROM kasmweb/nginx:1.25.3

RUN wget https://kasm-static-content.s3.amazonaws.com/kasm_release_1.13.1.421524.tar.gz \
&& tar -xf kasm_release_1.13.1.421524.tar.gz \
&& cp kasm_release/conf/nginx/* /etc/nginx/conf.d -r \
&& sed -i 's/server kasm_/server kasm-/g' /etc/nginx/conf.d/upstream_* \
&& sed -i 's/kasm_guac:3000/kasm-guac:3000/g' /etc/nginx/conf.d/services.d/kasmguac.conf \
&& cp kasm_release/www /srv -r \
&& rm /etc/nginx/conf.d/upstream_share.conf /etc/nginx/conf.d/services.d/share_api.conf \
&& rm kasm_release_1.13.1.421524.tar.gz kasm_release -r

COPY kasm_nginx.crt /etc/ssl/certs
COPY kasm_nginx.key /etc/ssl/private

RUN sed -i -e 's/http:/https:/' \
-e "s/kasm_api/localhost/g" \
-e "\#location /desktop/ {#a if (\$request_method = 'OPTIONS') {\n                    add_header 'Access-Control-Allow-Origin' 'https://kasm.tplant.au' always;\n                    add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS';\n                    add_header 'Access-Control-Allow-Headers' 'Authorization,Content-Type,Accept,Origin,User-Agent,DNT,Cache-Control,X-Mx-ReqToken,Keep-Alive,X-Requested-With,If-Modified-Since';\n                    add_header 'Access-Control-Allow-Credentials' 'true';\n                    \n                    return 204;\n                } " \
-e 's/^if/                if/g' /etc/nginx/conf.d/services.d/upstream_proxy.conf
