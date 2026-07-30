# Roxen 6.1 lab — a reproducible Roxen environment used as a parse oracle and
# as a realistic install layout for detection tests.
#
# Two stages: Pike is built from a pinned source tarball, then Roxen 6.1 is
# checked out at a pinned commit and installed where detection searches
# (/usr/local/roxen6). Roxen itself is Pike source — there is no compile step
# for it — so the expensive half is Pike.
#
# Deliberately NOT a CI dependency: the Pike build costs ~10-20 minutes. See
# harness/roxen-lab/README.md.

# ---------------------------------------------------------------------------
# Stage 1: build Pike from a pinned release tarball
# ---------------------------------------------------------------------------
# The tarball is used rather than a git checkout because it ships a generated
# `configure`, so the build does not depend on the host's autoconf version.
#
# Ubuntu rather than Debian for one specific reason: Pike 8.0's Mysql module
# refuses to build unless mysql.h's MYSQL_VERSION_ID and the client library's
# mysql_get_client_version() agree to within a hundred. Debian ships only
# MariaDB Connector/C, where they never do — measured in the lab as header
# 101118 (MariaDB server 10.11.18) against runtime 30319 (Connector/C 3.3.19),
# and the module is silently disabled. Ubuntu's libmysqlclient-dev is Oracle
# MySQL, where both report 80046. Roxen hard-exits without Mysql.mysql, so this
# is the difference between a lab that runs Roxen and one that only compiles it.
FROM ubuntu:24.04 AS pike-build

ARG PIKE_VERSION=8.0.1116
ARG PIKE_SHA256=5020063c755bb182177750221013b199198a7f1eb8ff26c1fb879d375c755891

ENV DEBIAN_FRONTEND=noninteractive

# libmysqlclient-dev and libpcre3-dev are not optional: roxenloader.pike
# hard-exits at startup unless Pike provides Mysql.mysql and Regexp.PCRE. A Pike
# built without them compiles Roxen source fine but cannot run the server, which
# would leave the lab useful as an oracle and useless as a lab.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      bison \
      ca-certificates \
      curl \
      libmysqlclient-dev \
      libbz2-dev \
      libfftw3-dev \
      libfreetype-dev \
      libgdbm-dev \
      libgif-dev \
      libgmp-dev \
      libjpeg-dev \
      libpcre3-dev \
      libpng-dev \
      libsqlite3-dev \
      libssl-dev \
      libtiff-dev \
      libxml2-dev \
      nettle-dev \
      zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl -fsSL -o pike.tar.gz \
      "https://pike.lysator.liu.se/pub/pike/all/${PIKE_VERSION}/Pike-v${PIKE_VERSION}.tar.gz" \
 && echo "${PIKE_SHA256}  pike.tar.gz" | sha256sum -c - \
 && tar xzf pike.tar.gz \
 && rm pike.tar.gz

# Pike's top-level Makefile drives configure. `--prefix=/usr/local` installs to
# /usr/local/pike/<version> with a /usr/local/bin/pike symlink, which is the
# layout pikeDetection.ts already probes for.
#
# Java and GTK are excluded: Roxen needs neither, and both add large build
# dependencies to an image whose only job is to compile Pike source.
#
# pike_cv_working_z=yes overrides one autoconf probe, deliberately. Pike's Gz
# module decides whether zlib works by compiling and RUNNING src/modules/Gz/
# gz_test.c, a 1998 copy of zlib's own example.c. Its test_sync() asserts that
# inflate() returns Z_DATA_ERROR after inflateSync() skips a damaged block;
# zlib 1.3 recovers from that block instead and returns Z_STREAM_END, so the
# test exits 1 and Pike installs a stub Gz with no zlib in it. Nothing is wrong
# with zlib — the probe encodes behaviour zlib stopped having. Roxen's
# Roxen.pmod uses Gz.File unconditionally, so a stub Gz means Roxen compiles
# and then fails to start. Verified in this image: gz_test.c prints
# "inflate should report DATA_ERROR" against zlib 1.3, while Gz itself works.
#
# Presetting the cache variable is autoconf's own supported way to answer a
# probe you have already answered by hand. Revisit if Pike updates gz_test.c.
WORKDIR /build/Pike-v${PIKE_VERSION}
RUN pike_cv_working_z=yes \
    make CONFIGUREARGS="--prefix=/usr/local --without-gtk --without-java --without-debug" \
      -j"$(nproc)" \
 && make install prefix=/usr/local \
 && rm -rf /build

# ---------------------------------------------------------------------------
# Stage 2: runtime with Roxen 6.1 installed
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS roxen-lab

# Pinned to a commit, not to the rxnpatch/6.1 branch tip: the index generator
# and every measured corpus number in openspec/changes/roxen-support must stay
# reproducible when upstream moves.
ARG ROXEN_COMMIT=4f1d04f82b3ea95f680cddab552d4912990c9c2f
ARG ROXEN_BRANCH=rxnpatch/6.1
ARG ROXEN_PREFIX=/usr/local/roxen6

ENV DEBIAN_FRONTEND=noninteractive

# mariadb-server is here because Roxen keeps its configuration in a database
# and starts its own mysqld to hold it. The commercial distribution bundles one
# under server/mysql/; the open-source tree does not, so the lab supplies the
# system's and points Roxen at it via the mysql-location.txt file Roxen already
# supports. 10.11 lands in Roxen's "maybe" version list and outside its known-bad
# one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      mariadb-client \
      mariadb-server \
      libbz2-1.0 \
      libfftw3-double3 \
      libfreetype6 \
      libgdbm6 \
      libgif7 \
      libgmp10 \
      libjpeg-turbo8 \
      libmysqlclient21 \
      libnettle8 \
      libpcre3 \
      libpng16-16 \
      libsqlite3-0 \
      libssl3 \
      libtiff6 \
      libxml2 \
      zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pike-build /usr/local/pike /usr/local/pike
COPY --from=pike-build /usr/local/bin/pike /usr/local/bin/pike

# Roxen has no build step of its own — installing it is placing the tree.
# A shallow fetch of the single pinned commit keeps the image small; the branch
# name is only needed because GitHub refuses a bare-SHA fetch on some configs.
RUN git init "${ROXEN_PREFIX}" \
 && git -C "${ROXEN_PREFIX}" remote add origin https://github.com/pikelang/Roxen.git \
 && git -C "${ROXEN_PREFIX}" fetch --depth 1 origin "${ROXEN_COMMIT}" \
 && git -C "${ROXEN_PREFIX}" checkout --detach FETCH_HEAD \
 && test "$(git -C "${ROXEN_PREFIX}" rev-parse HEAD)" = "${ROXEN_COMMIT}" \
 && rm -rf "${ROXEN_PREFIX}/.git"

# Roxen's start script builds its environment on first run (probing for
# Informix, Java, and so on). Doing it at build time means `docker run` starts
# a server rather than a setup.
#
# The two directories are created explicitly because the start script writes its
# pid file into ../configurations before anything else has had a chance to
# create it, and reports the failure as a shell error rather than a Roxen one.
RUN "${ROXEN_PREFIX}/server/start" --version \
 && mkdir -p "${ROXEN_PREFIX}/configurations" "${ROXEN_PREFIX}/logs"

# Tell Roxen where the database binaries are. This is Roxen's own documented
# override (roxenloader.pike's mysql_location()); without it Roxen looks only in
# server/mysql/, which the open-source tree does not ship, and exits.
RUN printf '%s\n' \
      'basedir = /usr' \
      'mysqld = /usr/sbin/mysqld' \
      'myisamchk = /usr/bin/myisamchk' \
      'mysqladmin = /usr/bin/mysqladmin' \
      'mysqldump = /usr/bin/mysqldump' \
      'mysql_upgrade = /usr/bin/mysql_upgrade' \
      > "${ROXEN_PREFIX}/server/mysql-location.txt"

ENV ROXEN_PREFIX=${ROXEN_PREFIX}
COPY oracle.pike /usr/local/bin/roxen-oracle.pike
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR ${ROXEN_PREFIX}
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["oracle", "--help"]
