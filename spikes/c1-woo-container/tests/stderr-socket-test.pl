#!/usr/bin/perl
# Test of c1-serve.sh when stdout and stderr are a socket (issue #99). Runs
# inside the c1 image, as root:
#   docker run --rm -v "$PWD/spikes/c1-woo-container/tests:/t" \
#     --entrypoint perl <image> /t/stderr-socket-test.pl
# php-fpm (error_log = /proc/self/fd/2) and nginx (error_log /dev/stderr) open
# their log path, and on Linux that open fails (ENXIO) when stderr is a socket:
# both servers exit at start. That is the measured cause of the arm 2 crash
# loop on Cloudflare. c1-serve.sh puts a pipe in front of stdout and stderr.
#
# Two arms, each with stdout and stderr on a UNIX socketpair:
#   fixed:  /usr/local/bin/c1-serve.sh. Must still run after 6 s, answer
#           /_fpm-ping with pong, exit 0 on SIGTERM, and its start line must
#           report fd2 as the socket it was given.
#   mutant: the same script without its two pipe lines. Must have exited.
# Exit 0 only when the fixed arm passes AND the mutant fails, so the test also
# proves that it can see the defect.
use strict; use warnings;
use Socket; use POSIX ":sys_wait_h";
$ENV{PHP_WORKERS} ||= 2;
my $fixed = "/usr/local/bin/c1-serve.sh";
my $mutant = "/tmp/c1-serve-nopipe.sh";
open(my $in, "<", $fixed) or die "read $fixed: $!";
open(my $out, ">", $mutant) or die "write $mutant: $!";
my $cut = 0;
while (my $l = <$in>) { if ($l =~ /^exec [12]> >\(exec cat/) { $cut++; next } print $out $l }
close $in; close $out; chmod 0755, $mutant;
die "the pipe lines were not found in $fixed (cut $cut, want 2)\n" unless $cut == 2;

sub arm {
	my ($script) = @_;
	socketpair(my $a, my $b, AF_UNIX, SOCK_STREAM, PF_UNSPEC) or die "socketpair: $!";
	my $pid = fork() // die "fork: $!";
	if ($pid == 0) {
		close $b;
		open(STDOUT, ">&", $a) or die; open(STDERR, ">&", $a) or die;
		exec "/bin/bash", $script; exit 127;
	}
	close $a; $b->blocking(0);
	sleep 6;
	my $log = ""; my $buf;
	while (defined(sysread($b, $buf, 65536)) && length $buf) { $log .= $buf }
	my $running = waitpid($pid, WNOHANG) == 0;
	my $ping = $running ? `curl -s -m 5 http://127.0.0.1/_fpm-ping` : "";
	my $rc = "not running";
	if ($running) {
		kill "TERM", $pid;
		for (1 .. 15) { last if waitpid($pid, WNOHANG) != 0; sleep 1 }
		if (kill 0, $pid) { kill "KILL", $pid; waitpid($pid, 0); $rc = "hung" } else { $rc = $? >> 8 }
	} else { $rc = "exited at start, status " . ($? >> 8) }
	while (defined(sysread($b, $buf, 65536)) && length $buf) { $log .= $buf }
	return ($running, $ping, $rc, $log);
}

# The fd probe of entrypoint.sh, against a known socket and a known pipe:
# on the socket it must say "fd2 socket:" and "open FAILED", on the pipe
# "fd2 pipe:" and "open ok". A readout that says the same for both is broken.
my $PROBE = q{echo "fd2 $(readlink /proc/$$/fd/2)"; if ( : >> /proc/$$/fd/2 ) 2>/dev/null; then echo "open ok"; else echo "open FAILED"; fi};
sub probe {
	my ($kind) = @_;
	my ($a, $b);
	if ($kind eq "socket") { socketpair($a, $b, AF_UNIX, SOCK_STREAM, PF_UNSPEC) or die "socketpair: $!" }
	else { pipe($b, $a) or die "pipe: $!" }
	my $pid = fork() // die "fork: $!";
	if ($pid == 0) {
		close $b; open(STDOUT, ">&", $a) or die; open(STDERR, ">&", $a) or die;
		exec "/bin/sh", "-c", $PROBE; exit 127;
	}
	close $a; waitpid($pid, 0); my $o = ""; my $buf;
	while (defined(sysread($b, $buf, 65536)) && length $buf) { $o .= $buf }
	return join(", ", split /\n/, $o);
}
my $ps = probe("socket"); my $pp = probe("pipe");
my $ok0 = $ps =~ /fd2 socket:/ && $ps =~ /open FAILED/ && $pp =~ /fd2 pipe:/ && $pp =~ /open ok/;
printf "%s entrypoint fd probe: on a socket: %s | on a pipe: %s\n", $ok0 ? "PASS" : "FAIL", $ps, $pp;
# Mutant: the f15fc47 readout (/proc/self inside $( ) and a redirected
# subshell). On a socket it must NOT pass the socket check.
$PROBE = q{echo "fd2 $(readlink /proc/self/fd/2 2>&1)"; if ( : >> /proc/self/fd/2 ) 2>/dev/null; then echo "open ok"; else echo "open FAILED"; fi};
my $pm = probe("socket");
my $okm = !($pm =~ /fd2 socket:/ && $pm =~ /open FAILED/);
printf "%s mutant fd probe (f15fc47) on a socket: %s\n", $okm ? "PASS" : "FAIL", $pm;
$ENV{C1_PROBE_OK} = $ok0 && $okm ? 1 : 0;
my ($r1, $p1, $c1, $l1) = arm($fixed);
# The start line must report the socket it was given (the diagnostic itself).
my $seen = $l1 =~ /c1-serve: start, fd2 socket:/ ? "socket" : "not socket";
my $ok1 = $r1 && $p1 eq "pong" && $c1 eq "0" && $seen eq "socket";
printf "%s fixed: running after 6 s %s, /_fpm-ping %s, SIGTERM exit %s, start line saw %s\n", $ok1 ? "PASS" : "FAIL", $r1 ? "yes" : "no", $p1 eq "" ? "(none)" : $p1, $c1, $seen;
print map { "   $_\n" } grep { /emerg|ERROR|failed|c1-serve:/ } split /\n/, $l1;
my ($r2, $p2, $c2, $l2) = arm($mutant);
my $ok2 = !$r2;
printf "%s mutant (no pipe): %s\n", $ok2 ? "PASS" : "FAIL", $r2 ? "still running: the test cannot see the defect" : "exited, as expected ($c2)";
print map { "   $_\n" } grep { /emerg|ERROR|failed|exited/ } split /\n/, $l2;
unlink $mutant;
exit($ok1 && $ok2 && $ENV{C1_PROBE_OK} ? 0 : 1);
