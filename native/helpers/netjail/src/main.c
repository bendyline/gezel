/*
 * gezel-netjail — run a command that must not reach the network.
 *
 *   gezel-netjail -- <command> [args...]
 *   gezel-netjail --self-test
 *
 * Gives a script the same property systemd's RestrictAddressFamilies=AF_UNIX
 * gives it, where systemd is not there to ask: inside a container, on WSL, on
 * a server without a user session. It sets no_new_privs, installs a seccomp
 * filter, and execs the command, which inherits the filter for good.
 *
 * The filter:
 *   - kills any syscall made under a foreign ABI (i386 or x32 on x86-64),
 *     which would otherwise reach a socketcall() the filter never sees;
 *   - lets socket() and socketpair() create AF_UNIX sockets only, and answers
 *     every other family with EAFNOSUPPORT, as RestrictAddressFamilies does;
 *   - refuses io_uring, whose socket operations bypass the socket() check,
 *     and ptrace / process_vm_*, which would let the script reach into a
 *     process outside the filter.
 *
 * Inherited file descriptors are left alone: the sandbox runner passes the
 * script exactly the pipes it needs, its RPC channel among them.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define NETJAIL_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NETJAIL_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "gezel-netjail supports x86-64 and arm64 only"
#endif

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS SECCOMP_RET_KILL
#endif

#define X32_SYSCALL_BIT 0x40000000u

#define RET(value) BPF_STMT(BPF_RET | BPF_K, (value))
#define LOAD(field) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (field))
/* args[0] low word: both supported targets are little-endian. */
#define ARG0 ((unsigned int)offsetof(struct seccomp_data, args[0]))

/* socket()/socketpair(): AF_UNIX passes, every other family is refused. */
#define FAMILY_CHECK(nr)                                              \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 4), LOAD(ARG0),        \
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),             \
      RET(SECCOMP_RET_ALLOW), RET(SECCOMP_RET_ERRNO | EAFNOSUPPORT)

#define REFUSE(nr) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), RET(SECCOMP_RET_ERRNO | EPERM)

static struct sock_filter filter[] = {
    LOAD((unsigned int)offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NETJAIL_AUDIT_ARCH, 1, 0),
    RET(SECCOMP_RET_KILL_PROCESS),
    LOAD((unsigned int)offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, X32_SYSCALL_BIT, 0, 1),
    RET(SECCOMP_RET_KILL_PROCESS),
#endif
    FAMILY_CHECK(__NR_socket),
    FAMILY_CHECK(__NR_socketpair),
    REFUSE(__NR_io_uring_setup),
    REFUSE(__NR_io_uring_enter),
    REFUSE(__NR_io_uring_register),
    REFUSE(__NR_ptrace),
    REFUSE(__NR_process_vm_readv),
    REFUSE(__NR_process_vm_writev),
    RET(SECCOMP_RET_ALLOW),
};

static int install_filter(void) {
  struct sock_fprog program = {
      .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
      .filter = filter,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "gezel-netjail: PR_SET_NO_NEW_PRIVS failed: %s\n", strerror(errno));
    return -1;
  }
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) != 0) {
    fprintf(stderr, "gezel-netjail: installing the seccomp filter failed: %s\n",
            strerror(errno));
    return -1;
  }
  return 0;
}

/* The property the runner relies on, checked from inside the filter. */
static int self_test(void) {
  if (install_filter() != 0) return 2;
  int inet = socket(AF_INET, SOCK_STREAM, 0);
  if (inet >= 0 || errno != EAFNOSUPPORT) {
    fprintf(stderr, "gezel-netjail: an AF_INET socket was not refused\n");
    return 1;
  }
  int inet6 = socket(AF_INET6, SOCK_DGRAM, 0);
  if (inet6 >= 0) {
    fprintf(stderr, "gezel-netjail: an AF_INET6 socket was not refused\n");
    return 1;
  }
  int local = socket(AF_UNIX, SOCK_STREAM, 0);
  if (local < 0) {
    fprintf(stderr, "gezel-netjail: an AF_UNIX socket was refused: %s\n", strerror(errno));
    return 1;
  }
  close(local);
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) {
    fprintf(stderr, "gezel-netjail: an AF_UNIX socketpair was refused: %s\n", strerror(errno));
    return 1;
  }
  close(pair[0]);
  close(pair[1]);
  puts("gezel-netjail: ok");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
  if (argc < 3 || strcmp(argv[1], "--") != 0) {
    fprintf(stderr, "usage: gezel-netjail -- <command> [args...]\n       gezel-netjail --self-test\n");
    return 64;
  }
  if (install_filter() != 0) return 126;
  execvp(argv[2], &argv[2]);
  fprintf(stderr, "gezel-netjail: could not run %s: %s\n", argv[2], strerror(errno));
  return 127;
}
