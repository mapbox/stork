FROM amazonlinux

RUN yum install -y wget zip
RUN wget -q https://dl.yarnpkg.com/rpm/yarn.repo -O /etc/yum.repos.d/yarn.repo
RUN curl --silent --location https://rpm.nodesource.com/setup_6.x | bash -
RUN yum install -y yarn
