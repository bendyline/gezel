/*
 * gezel-sandbox — start a command under rules it cannot lift.
 *
 *   gezel-sandbox --deny-net -- <command> [args...]
 *   gezel-sandbox --features
 *   gezel-sandbox --self-test
 *   gezel-sandbox --help
 *
 * Each rule is a flag, and a run must name at least one: the runner says
 * what it wants, so a rule added later never changes what an existing caller
 * gets. An unknown flag is refused, so a newer runner asking an older helper
 * for a rule it lacks fails loudly instead of running unconfined. --features
 * lists the rules this build has, one per line; whether this kernel enforces
 * them is for the caller to prove, as the sandbox runner does.
 *
 * Every rule is one an unprivileged process can apply to itself before it
 * execs, because that is what works under Docker's default seccomp profile
 * (creating namespaces does not). no_new_privs is set first, for all of them.
 *
 * --deny-net gives a script the property systemd's
 * RestrictAddressFamilies=AF_UNIX gives it, where systemd is not there to
 * ask: inside a container, on WSL, on a server without a user session. Its
 * seccomp filter:
 *   - kills any syscall made under a foreign ABI (i386 or x32 on x86-64),
 *     which would otherwise reach a socketcall() the filter never sees;
 *   - lets socket() and socketpair() create AF_UNIX sockets only, and answers
 *     every other family with EAFNOSUPPORT, as RestrictAddressFamilies does;
 *   - refuses io_uring, whose socket operations bypass the socket() check,
 *     and ptrace / process_vm_* / pidfd_getfd, which would let the script
 *     reach into a process outside the filter. pidfd_getfd would copy an
 *     open socket out of the parent, which is the Gezel daemon.
 *
 * Inherited file descriptors are left alone: the sandbox runner passes the
 * script exactly the pipes it needs, its RPC channel among them.
 *
 * Exit codes: 64 for a usage error, 126 when a rule could not be applied,
 * 127 when the command could not be started.
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
#define SANDBOX_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define SANDBOX_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "gezel-sandbox supports x86-64 and arm64 only"
#endif

#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS SECCOMP_RET_KILL
#endif

#define X32_SYSCALL_BIT 0x40000000u

/* Linux 5.6; syscalls since 5.1 share one number on every architecture. */
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif

/* The rules this build has, as --features prints them. */
static const char *const FEATURES[] = {"deny-net"};

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

static struct sock_filter deny_net_filter[] = {
    LOAD((unsigned int)offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SANDBOX_AUDIT_ARCH, 1, 0),
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
    REFUSE(__NR_pidfd_getfd),
    RET(SECCOMP_RET_ALLOW),
};

/*
 * The syscalls REFUSE answers, for the self-test. Each is called with
 * arguments that would fail some other way, or do nothing, if it got
 * through, so EPERM means a filter refused it. Under Docker's default
 * profile that can be Docker's rather than this one; the build's self-test
 * runs on a bare runner, where it can only be this one.
 */
static const struct {
  long nr;
  const char *name;
} REFUSED[] = {
    {__NR_io_uring_setup, "io_uring_setup"},
    {__NR_io_uring_enter, "io_uring_enter"},
    {__NR_io_uring_register, "io_uring_register"},
    {__NR_ptrace, "ptrace"},
    {__NR_process_vm_readv, "process_vm_readv"},
    {__NR_process_vm_writev, "process_vm_writev"},
    {__NR_pidfd_getfd, "pidfd_getfd"},
};

static void print_usage(FILE *stream) {
  fprintf(stream,
          "usage: gezel-sandbox --deny-net -- <command> [args...]\n"
          "       gezel-sandbox --features\n"
          "       gezel-sandbox --self-test\n"
          "       gezel-sandbox --help\n");
}

static int usage(void) {
  print_usage(stderr);
  return 64;
}

static int set_no_new_privs(void) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "gezel-sandbox: PR_SET_NO_NEW_PRIVS failed: %s\n", strerror(errno));
    return -1;
  }
  return 0;
}

static int apply_deny_net(void) {
  struct sock_fprog program = {
      .len = (unsigned short)(sizeof(deny_net_filter) / sizeof(deny_net_filter[0])),
      .filter = deny_net_filter,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) != 0) {
    fprintf(stderr, "gezel-sandbox: --deny-net: installing the seccomp filter failed: %s\n",
            strerror(errno));
    return -1;
  }
  return 0;
}

static int print_features(void) {
  for (size_t i = 0; i < sizeof(FEATURES) / sizeof(FEATURES[0]); i++) puts(FEATURES[i]);
  return 0;
}

/* Every rule this build has, checked from inside it. */
static int self_test(void) {
  if (set_no_new_privs() != 0 || apply_deny_net() != 0) return 2;
  int inet = socket(AF_INET, SOCK_STREAM, 0);
  if (inet >= 0 || errno != EAFNOSUPPORT) {
    fprintf(stderr, "gezel-sandbox: --deny-net: an AF_INET socket was not refused\n");
    return 1;
  }
  int inet6 = socket(AF_INET6, SOCK_DGRAM, 0);
  if (inet6 >= 0) {
    fprintf(stderr, "gezel-sandbox: --deny-net: an AF_INET6 socket was not refused\n");
    return 1;
  }
  int local = socket(AF_UNIX, SOCK_STREAM, 0);
  if (local < 0) {
    fprintf(stderr, "gezel-sandbox: --deny-net: an AF_UNIX socket was refused: %s\n",
            strerror(errno));
    return 1;
  }
  close(local);
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) {
    fprintf(stderr, "gezel-sandbox: --deny-net: an AF_UNIX socketpair was refused: %s\n",
            strerror(errno));
    return 1;
  }
  close(pair[0]);
  close(pair[1]);
  for (size_t i = 0; i < sizeof(REFUSED) / sizeof(REFUSED[0]); i++) {
    errno = 0;
    if (syscall(REFUSED[i].nr, -1L, 0L, 0L, 0L, 0L, 0L) != -1 || errno != EPERM) {
      fprintf(stderr, "gezel-sandbox: --deny-net: %s was not refused\n", REFUSED[i].name);
      return 1;
    }
  }
  puts("gezel-sandbox: ok");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--features") == 0) return print_features();
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    print_usage(stdout);
    return 0;
  }

  int rules = 0;
  int deny_net = 0;
  int i = 1;
  for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
    if (strcmp(argv[i], "--deny-net") == 0) {
      deny_net = 1;
      rules++;
    } else {
      fprintf(stderr, "gezel-sandbox: unknown option %s; --features lists the rules this build has\n",
              argv[i]);
      return usage();
    }
  }
  if (i + 1 >= argc) return usage();
  if (rules == 0) {
    fprintf(stderr, "gezel-sandbox: name at least one rule; --features lists them\n");
    return usage();
  }

  if (set_no_new_privs() != 0) return 126;
  if (deny_net && apply_deny_net() != 0) return 126;

  char **command = &argv[i + 1];
  execvp(command[0], command);
  fprintf(stderr, "gezel-sandbox: could not run %s: %s\n", command[0], strerror(errno));
  return 127;
}
