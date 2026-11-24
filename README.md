# RT Systems Companion

Players use the Pocket OS on their real phones. It isn't a copy of the
pocket: it's the pocket itself (`rt_pocket.lua` and everything it loads),
running in the phone's browser. Every pocket app works, looks and behaves
as it does in game, and every RT Systems update reaches phones too.

Admin accounts can't sign in on a phone. Admins use RT Systems in game
only.

## How it fits together

```
 phone (browser)  --https-->  Cloudflare  -->  relay (AMP instance)  <--wss--  RT Systems server
   Pocket OS on fengari          (your domain)     companion/relay.js            (CC:Tweaked, in game)
```

* **The relay** (`relay.js`, Node 18 or newer, no packages to install)
  serves the phone app and passes requests between phones and the RT
  Systems server. It keeps nothing: no accounts, no passwords, no game
  data.
* **The RT Systems server** connects out to the relay over a websocket
  (CC's `http.websocket`) and proves it's yours with a link key. Every
  rule is enforced on the server (`systems/companion.lua`):
  * Phones may send only the requests the Pocket OS itself sends.
  * Admin accounts are refused, including any request that carries an
    admin's login.
  * Repeated wrong passwords are slowed down.
  * A new phone needs its owner's OK in game: the right password gets a
    notice to the player, and the phone signs in once they **Allow** it
    (each phone keeps a random id of its own). Admin > Companion can
    turn this off, limit the app to players it names, and sign out one
    player's phones. A phone's login unused for 30 days ends (Admin >
    Companion: *Logins end*).
* **Alerts** (Web Push): a player turns them on under the screen. The
  RT server decides what to send (only while they're away, never a
  muted kind); the relay encrypts each one for that phone and hands it
  to the phone's push service. Its keys are made on first start and
  kept in `vapid.json` beside `relay.js` (or in `RT_DATA`): keep that
  file, or phones must turn Alerts on again. Set `RT_CONTACT` (a
  `mailto:` address) in AMP: the push services are told it. The relay
  sends alerts only to Apple's, Google's, Mozilla's and Microsoft's
  push services, never to another address.
* **Each hour** the relay writes a line to AMP's console: requests,
  refusals, the most phones at once, alerts sent and failed, linked or not.
* **The relay limits** each address to 6 phones at once and 20 new
  connections a minute, drops requests past 40 a second, and closes a
  phone that keeps that up for 3 seconds. It believes Cloudflare's
  visitor address only from connections made on the machine or the
  home network (where `cloudflared` runs). `RT_PER_IP`, `RT_JOINS` and
  `RT_MAX_PHONES` change the limits.
* **The phone** runs the Pocket OS on [fengari](https://github.com/fengari-lua/fengari)
  (Lua in JavaScript, MIT) with `public/rt/shim.lua`, a small CraftOS of
  its own. The screen is the pocket's 156 x 180 pixels, scaled up crisp.
  The phone keeps its own settings and saved login in the browser.

## Install with AMP (CubeCoders)

1. **Add the template.** In AMP, go to *Configuration > Instance
   Deployment*, choose *Add* under *Configuration Repository*, and enter
   the GitHub repository that holds this folder's `amp/` files, as
   `owner/repo:branch`. Click *Fetch*, then refresh the page.

   For a local-only setup, copy the `amp/` files into a folder named
   with the `LOCAL` prefix and a `-main` suffix under AMP's
   `Plugins/ADSModule/DeploymentTemplates`.
2. **Create an instance** of *RT Systems Companion*.
3. **Choose where it gets the companion from**, under *Download Type*:
   * *GitHub release*: a release of your repository with
     `RTCompanion.zip` attached.
   * *Download URL*: a link straight to `RTCompanion.zip`.
   * *Manual*: upload this folder's `relay.js` and `public/` into the
     instance's `app` folder with AMP's File Manager.

   Then run *Update*. AMP downloads Node.js itself.
4. **Link it in game.** Open *Admin > Companion* and choose *New key*,
   then put that key in the instance's *Link Key* setting. Set the
   *Relay address* to your domain with `/rt-link` on the end, for
   example `wss://phone.yourdomain.com/rt-link`. Start the instance.
   Admin > Companion should show **Linked**.

## Cloudflare Tunnel (HTTPS to your AMP server)

The tunnel gives the companion an HTTPS address on your domain without
opening any port on your router. A small Cloudflare program,
`cloudflared`, runs on the AMP machine and connects out to Cloudflare.
Visitors to `phone.yourdomain.com` reach the relay through it.

1. **Create the tunnel.** In the Cloudflare dashboard go to
   **Networking > Tunnels** (older Zero Trust dashboards: **Networks >
   Tunnels**) and choose **Create Tunnel**. Name it, for example
   `rt-companion`, and choose **Create Tunnel**.
2. **Install the connector on the AMP machine.** Under *Setup
   Environment*, pick that machine's system (Linux or Windows) and
   architecture. Copy the commands under *Install and Run* and run them
   in a terminal on the AMP machine (on Windows, an administrator
   Command Prompt). They install `cloudflared` as a service, so it
   starts with the machine. When the tunnel shows **Healthy**, choose
   **Continue**.
3. **Point a hostname at the relay.** On the tunnel's page, under
   **Routes**, choose **Add route > Published application**:
   * *Hostname*: a subdomain, such as `phone`, and your domain from the list.
   * *Service URL*: `http://localhost:8473`. That's the instance's
     *Relay Port*. If `cloudflared` runs on a different machine from
     AMP, use the AMP machine's address instead, such as
     `http://192.168.1.20:8473`.

   Choose **Add route**. Cloudflare creates the DNS record itself.
4. **Keep the relay private to the tunnel.** With `cloudflared` on the
   same machine, set the instance's IP binding to `127.0.0.1` in AMP
   (or block port 8473 in the machine's firewall). Only the tunnel can
   reach it then.
5. **Check these Cloudflare settings for the domain:**
   * **WebSockets: on** (*Network*). It's on to begin with. The RT
     server and the phones both need it.
   * **Rocket Loader: off** for this hostname (*Speed > Optimization*,
     or a Configuration Rule for `phone.yourdomain.com`). It rewrites
     pages' scripts, and the app must load as it is.
   * **No Cloudflare Access login** on this hostname. The RT Systems
     server and the app can't sign in to it. Players log in with their
     RT Systems accounts.
6. **Link the game.** In game, open **Admin > Companion**. Set the
   *Relay address* to `wss://phone.yourdomain.com/rt-link`, choose
   **New key**, and put that key in the instance's *Link Key* setting
   in AMP. Restart the instance. Admin > Companion shows **Linked**
   within half a minute.
7. **Check it.** In game, **Admin > Companion > Check the relay** says
   whether the relay answers, is linked and has the same key. Opening
   `https://phone.yourdomain.com/healthz` in a browser shows only
   `{"ok":true}` (the rest is told only to a request carrying the link
   key), and the address itself shows the pocket's login.

CC:Tweaked needs its HTTP API on (it is unless your config turned it
off). The RT Systems server calls out to your domain like any website,
so no `http` rule changes are needed. Big answers go down the link in
pieces, so CC's 128 KB websocket message limit doesn't need raising.

## Network security

The companion needs no open ports: the tunnel connects out. The
Minecraft server is what's exposed. With a **DNS only** (gray cloud)
record, anyone can look up your domain and get your home IP address.
An orange-cloud (proxied) record doesn't fix that for Minecraft:
Cloudflare's ordinary proxy carries web traffic only, so players
couldn't connect.

**1. Hide the address (pick one).**
* **A Minecraft proxy service.** TCPShield has a free plan for Java
  servers. You point your domain at it, and it passes players on to
  you. Check that it works with your NeoForge setup before switching:
  the server then sees the proxy's address for every player unless a
  real-IP mod is installed.
* **Cloudflare Spectrum** carries Minecraft through Cloudflare. For
  Minecraft it's a paid add-on on the Pro and Business plans, not
  the Free plan.
* **A small VPS** (any cheap cloud server) running a WireGuard tunnel
  home and forwarding port 25565 to you (HAProxy or iptables). The
  domain points at the VPS; your home IP is never published.

Old DNS records stay in public history sites, so after moving behind
any of these, ask your ISP for a new IP address (restarting the
modem sometimes does it; otherwise ask).

**2. Close everything else.**
* **Router:** forward only TCP 25565 to the Minecraft machine. Remove
  any other forwards, and turn **UPnP off** so programs can't open
  ports by themselves.
* **Firewall on the machine:** allow 25565 in, deny everything else
  inbound. Once a proxy or VPS is in front, allow 25565 only from its
  addresses.
* **Never expose AMP's web panel** (port 8080) or SSH to the internet.
  Reach AMP through its own Cloudflare Tunnel hostname protected by
  **Cloudflare Access** with a one-time code or MFA, or only from your
  home network. Turn on two-factor sign-in in AMP itself.
* If you use SSH at all: keys only, no passwords, and fail2ban.

**3. The Minecraft server's own settings** (`server.properties`):
* `online-mode=true` (only real Minecraft accounts).
* `white-list=true` and `enforce-whitelist=true` for a private server.
* `enforce-secure-profile=true`.
* `enable-rcon=false` and `enable-query=false`, unless you use them
  (and then never forwarded on the router).

**4. CC:Tweaked.** Keep its default rule that stops in-game computers
reaching addresses on your home network (in
`computercraft-server.toml`, the `[[http.rules]]` entry with
`host = "$private"` and `action = "deny"`). Without it, a player's
computer could reach your router or AMP panel from inside the game. The
RT Systems server only needs your public domain, which the rule allows.

**5. Upkeep.** Keep Java, NeoForge, the mods, AMP and `cloudflared`
updated; let AMP take scheduled backups and keep a copy off the
machine. If you can, put the server on its own network (a guest
network or VLAN) away from your personal devices.

## For players

Open your domain in Safari (iPhone) or Chrome (Android). A card says how
to **Add to Home Screen**: it opens full screen with its own icon, as an
app does. Log in as you would on a pocket.

* The screen is a pocket's 26 cells wide and **as tall as the phone has
  room for**: Home holds more rows of apps, lists show more. **Pocket
  size** switches to a pocket's own 26 x 20, exactly as in game
  (**Phone size** switches back). The phone remembers which.
* **Keyboard** brings up the phone's keyboard. The screen slides up
  while it's open, so what you type stays in sight. **Back** is the
  pocket's own swipe in from the left edge.
* **Sounds**: the chimes and game sounds play on the phone's speaker
  after your first tap. The pocket's Sounds setting turns them off.
* The app and the pocket's files are kept on the phone, so it opens
  at once. A new release is fetched the next time it's opened.

**A new phone:** the first login says to let it in from the notice in
game. Tap the notice there, choose **Allow**, and log in on the phone
again. *Your phones* in the in-game Settings forgets them all.

The same rules apply as on a pocket in game. For example, apps that
need a phone plan need one here too.

## Files

| | |
|---|---|
| `relay.js` | the relay |
| `public/` | the phone app: `index.html`, `app.js` (the page), `worker.js` (runs the pocket), `rt/shim.lua` (the CraftOS), `fengari.js` (bundled by `tools/companion_bundle.py`), `pocket/` (the release's pocket files and `manifest.json`, made by `tools/companion_pack.py`) |
| `amp/` | the AMP template (based on CubeCoders' own Node.js template, MIT) |
| `vendor/` | fengari (MIT) and sprintf-js (BSD-3), with their licences |
| `test_relay.js` | `node test_relay.js`: the relay, end to end |
