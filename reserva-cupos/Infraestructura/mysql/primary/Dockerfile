FROM mysql:8.4

COPY primary.cnf /etc/mysql/conf.d/primary.cnf
RUN chmod 644 /etc/mysql/conf.d/primary.cnf

COPY init/ /docker-entrypoint-initdb.d/
