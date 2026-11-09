// The Code tab's view of the guest's files: a small HTTP file server in the guest (Perl, which every Ubuntu has as perl-base, so
// no image change), started in a terminal of its own while the Code tab is open. The page reaches it through Nanite's network
// (nv.network.fetch to the guest's port), so it is not reachable from outside the machine.
import type { Nanite } from "./machine";

export const FSD_PORT = 7070;
// GET /ls?p=DIR -> "type\tsize\tname" lines (d, f); GET /stat?p= -> "type\tsize\tmtime\tctime"; GET /read?p=FILE -> bytes; PUT /write?p=FILE (body); POST /mkdir?p=, /rm?p=,
// /mv?p=&to=. One request per connection.
export const FSD = String.raw`
use IO::Socket::INET;
my $s = IO::Socket::INET->new(LocalAddr => "0.0.0.0", LocalPort => ${FSD_PORT}, Listen => 16, ReuseAddr => 1) or die "fsd: $!\n";
$| = 1; print "fsd ready\n";
sub dec { my $x = shift // ""; $x =~ tr/+/ /; $x =~ s/%([0-9A-Fa-f]{2})/chr hex $1/ge; $x }
while (my $c = $s->accept) {
  binmode $c; my $l = <$c>; next unless $l; my ($m, $u) = split / /, $l;
  my %h; while (my $x = <$c>) { $x =~ s/\r?\n$//; last if $x eq ""; my ($k, $v) = split /:\s*/, $x, 2; $h{lc $k} = $v }
  my $body = ""; my $n = $h{"content-length"} || 0;
  while (length($body) < $n) { last unless read($c, $body, $n - length($body), length($body)) }
  my ($path, $q) = split /\?/, $u, 2; my %a = map { my ($k, $v) = split /=/, $_, 2; ($k, dec($v)) } split /&/, ($q // "");
  my $p = $a{p} // "/"; my ($st, $out) = (200, "");
  if ($path eq "/ls") {
    if (opendir(my $d, $p)) { for my $e (sort readdir $d) { next if $e eq "." || $e eq ".."; my $f = "$p/$e"; $out .= (-d $f ? "d" : "f") . "\t" . ((-s $f) || 0) . "\t$e\n" } }
    else { ($st, $out) = (404, "$!") }
  } elsif ($path eq "/stat") { my @s = stat $p; if (@s) { $out = (-d _ ? "d" : "f") . "\t$s[7]\t$s[9]\t$s[10]" } else { ($st, $out) = (404, "$!") } }
  elsif ($path eq "/read") { if (open(my $f, "<:raw", $p)) { local $/; $out = <$f> // "" } else { ($st, $out) = (404, "$!") } }
  elsif ($path eq "/write") { if (open(my $f, ">:raw", $p)) { print $f $body; close $f } else { ($st, $out) = (500, "$!") } }
  elsif ($path eq "/mkdir") { mkdir $p or ($st, $out) = (500, "$!") }
  elsif ($path eq "/rm") { ((-d $p && !-l $p) ? system("rm", "-rf", "--", $p) == 0 : unlink $p) or ($st, $out) = (500, "$!") }
  elsif ($path eq "/mv") { rename $p, $a{to} or ($st, $out) = (500, "$!") }
  else { ($st, $out) = (404, "no such call") }
  print $c "HTTP/1.1 $st X\r\nContent-Length: " . length($out) . "\r\nConnection: close\r\n\r\n$out"; close $c;
}`;

export type Entry = { name: string; path: string; dir: boolean; size: number };

export class GuestFiles {
  constructor(private readonly nv: Nanite) {}
  // One request at a time: the server serves one connection at a time, and while it is busy Nanite refuses the next ones
  // (no backlog). A refused one is tried again.
  private static queue: Promise<unknown> = Promise.resolve();
  private call(op: string, p: string, init: { method?: string; body?: Uint8Array | string } = {}, extra = ""): Promise<Response> {
    const run = async () => {
      for (let i = 0; ; i++) {
        try {
          const r = await this.nv.network.fetch(FSD_PORT, `/${op}?p=${encodeURIComponent(p)}${extra}`, init);
          const body = await r.arrayBuffer();   // read whole, before the next request goes
          if (!r.ok) throw Object.assign(new Error(`${p}: ${new TextDecoder().decode(body) || r.status}`), { final: true });
          return new Response(body);
        } catch (e) {
          if ((e as { final?: boolean }).final || i >= 4 || !/refused/.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        }
      }
    };
    const res = GuestFiles.queue.then(run, run);
    GuestFiles.queue = res.catch(() => {});
    return res;
  }
  async ls(dir: string): Promise<Entry[]> {
    const text = await (await this.call("ls", dir)).text();
    return text.split("\n").filter(Boolean).map((l) => {
      const [t, size, ...name] = l.split("\t"); const n = name.join("\t");
      return { name: n, path: dir === "/" ? `/${n}` : `${dir}/${n}`, dir: t === "d", size: +size! };
    }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }
  async stat(path: string): Promise<{ dir: boolean; size: number; mtime: number; ctime: number }> {
    const [t, size, mtime, ctime] = (await (await this.call("stat", path)).text()).split("\t");
    return { dir: t === "d", size: +size!, mtime: +mtime! * 1000, ctime: +ctime! * 1000 };
  }
  async read(path: string): Promise<Uint8Array> { return new Uint8Array(await (await this.call("read", path)).arrayBuffer()); }
  async write(path: string, data: Uint8Array | string): Promise<void> { await this.call("write", path, { method: "PUT", body: data }); }
  async mkdir(path: string): Promise<void> { await this.call("mkdir", path, { method: "POST" }); }
  async rm(path: string): Promise<void> { await this.call("rm", path, { method: "POST" }); }
  async mv(path: string, to: string): Promise<void> { await this.call("mv", path, { method: "POST" }, `&to=${encodeURIComponent(to)}`); }
  /** Waits until the server answers (it was just started). */
  async ready(timeoutMs = 15000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try { await this.ls("/"); return; } catch (e) { if (Date.now() > until) throw e; }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
