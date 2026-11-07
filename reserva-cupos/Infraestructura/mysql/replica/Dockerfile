FROM mysql:8.4

COPY replica.cnf /etc/mysql/conf.d/replica.cnf
RUN chmod 644 /etc/mysql/conf.d/replica.cnf

COPY init/ /docker-entrypoint-initdb.d/