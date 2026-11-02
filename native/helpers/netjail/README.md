# gezel-netjail

A first-party Linux helper that runs a script with no network: it sets
`no_new_privs`, installs a seccomp filter, and execs the command.

```sh
gezel-netjail -- node script.js
gezel-netjail --self-test
```

The sandbox runner (`packages/service/src/sandbox/runner.ts`) uses it for
`denyNet` scripts when `systemd-run --user` is not available: inside a Gezel
container, on WSL, or on a server with no user session. It gives the same
guarantee as systemd's `RestrictAddressFamilies=AF_UNIX`:

- `socket()` and `socketpair()` create `AF_UNIX` sockets only; every other
  family gets `EAFNOSUPPORT`.
- A syscall made under a foreign ABI (i386 or x32 on x86-64) kills the
  process, so `socketcall()` cannot route around the check.
- `io_uring_*`, `ptrace` and `process_vm_*` are refused, because each could
  reach the network or another process outside the filter.

It does not confine the file system; the runner's Node permission model
does that, as it does under systemd. It links the system C library like the
other engines, and nothing it uses needs more than the release's glibc 2.38
floor. See ADR 0029.

Build: `native/helpers/netjail/build.sh` (CMake + Ninja), which runs the
self-test and writes `native/build/<platform>/gezel-netjail`. CI builds it in
`build-native.yml` for `linux-x64` and `linux-arm64`.
