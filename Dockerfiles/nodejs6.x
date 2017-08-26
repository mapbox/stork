FROM amazonlinux

RUN yum install -y wget zip
RUN curl -sL https://nodejs.org/dist/v6.11.1/node-v6.11.1-linux-x64.tar.gz | tar zxC /usr/local --strip-components=1
RUN rm -rf /usr/local/lib/node_modules/npm && \
  mkdir /usr/local/lib/node_modules/npm && \
  curl -sL https://github.com/npm/npm/archive/v5.3.0.tar.gz | tar xz -C /usr/local/lib/node_modules/npm --strip-components=1
