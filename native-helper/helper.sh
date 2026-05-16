#!/usr/bin/env bash
# Wrapper được Chrome gọi qua Native Messaging.
# Phải absolute path tới node + script. Không dùng env vì Chrome không inherit PATH user.
exec /usr/bin/node /opt/fotor-vpn-helper/helper.js "$@"
