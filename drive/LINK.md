# Bakar Drive link v1: directions from the phone to the glasses

The glasses page shows the next turn from the Bakar Drive navigator on the phone. The phone side is a
small sender that reads Bakar Drive's live navigation and publishes it, encrypted, for this page only.
Free public MQTT brokers carry the messages; they only ever see ciphertext.

Nothing in the page's address is secret. A copied link can't read or send directions, because the
glasses make their own key and the phone accepts that key only after the wearer compares a code.

## Address

```
https://baklarrrr.github.io/glass-home/drive/?t=<topic>&p=<phone key>
```

- `t`: the link's topic, 16 to 64 characters of `A-Z a-z 0-9 _ -` (the sender uses 16 random bytes,
  base64url, 22 characters).
- `p`: the sender's P-256 public key, raw uncompressed point (65 bytes, first byte `0x04`), base64url
  without padding (87 characters).
- The same two values may also come in the `#fragment`. The query form is preferred because every
  launcher keeps it. Without `t` and `p` the page runs on phone GPS alone.

## Keys

1. The glasses make a P-256 key pair once per phone link and keep the private half in IndexedDB as a
   non-extractable key (database `bakar-drive`, store `keys`, key `dev:<t>:<p>`). A different link never
   reuses it. The link itself is kept under `pairing`, and only once its keys work.
   If the glasses already have a working link and are opened with a different one, they keep using the
   one they have and ask first (Use this phone / Back). Back also removes the new link from the address.
2. `devPub` = the glasses' raw public key (65 bytes). `devId` = the first 16 characters of
   base64url(SHA-256(`devPub`)).
3. `shared` = ECDH(glasses private, phone public): the 32-byte x coordinate. This is what WebCrypto's
   `deriveBits(…, 256)` and Java's `KeyAgreement("ECDH").generateSecret()` both return.
4. Two AES-256-GCM keys from HKDF-SHA256 with `ikm = shared`, `salt = UTF-8("bakar-drive v1")`,
   `L = 32`:
   - `up` (glasses to phone): `info = UTF-8("up|" + devId + "|" + t)`
   - `down` (phone to glasses): `info = UTF-8("down|" + devId + "|" + t)`
5. Pairing code, shown on both sides: the first 4 bytes of
   SHA-256(UTF-8("bakar-drive pair v1|") ‖ `devPub`) as an unsigned big-endian integer, mod 1,000,000,
   six digits with leading zeros. Displayed as `123 456`.

## Messages

Sealing: AES-GCM, a fresh random 12-byte IV, 128-bit tag, no additional data.
`sealed` = base64url(IV ‖ ciphertext ‖ tag), no padding. Plaintext is UTF-8 JSON.

| Direction | Topic | Payload | QoS |
|---|---|---|---|
| glasses → phone | `bkd/<t>/u` | `1.<devPub base64url>.<sealed with up>` | 1 |
| phone → glasses | `bkd/<t>/d/<devId>` | `1.<sealed with down>` | 0 (hello replies 1) |

Neither side retains messages on the broker. The glasses drop any phone → glasses payload longer than
5,600 characters, and any sealed body over 4,096 bytes, before trying to open it.

### Hello (glasses → phone)

```json
{"c":"hello","id":"<12 base64url chars>","ts":1793580000000,"v":1}
```

Sent when a broker connects, then every 20 s while the page is visible. Nothing is sent while the
page is hidden. The phone treats a device as listening for 45 s after its last hello.

### Pair reply (phone → glasses)

```json
{"m":"pair","ok":false,"code":"123456","re":"<hello id>","at":1793580000000}
```

`re` is required: the id of the hello being answered. The glasses keep the ids of their last six hellos
and drop a reply that names none of them.

`ok:false`: this glasses key isn't accepted yet; the page shows the code and asks the wearer to accept
it in the phone app. `ok:true`: accepted. The phone answers an unknown key at most once every 10 s.

### Directions (phone → glasses)

```json
{"m":"nav","sid":"Zx81kq2mP0aa","seq":42,"at":1793580000000,"re":"AbCdEfGhIjKl",
 "nav":{"ss":"OnRoute","turn":"TURN_RIGHT","exit":0,"toTurn":"350 m","next":"King St W",
        "street":"Bay St","left":"12 km","secs":1380,"pct":41.5,"sim":false}}
```

`nav` is `null` when Bakar Drive has no route. Sent once a second to each accepted device that is
listening, and at once when the turn or the next street changes.

| Field | Meaning | Rule on the glasses |
|---|---|---|
| `sid` | sender session, random per start | 8 to 32 base64url characters. A new session takes over only if its `at` is no more than 5 s behind the last accepted frame; once replaced, a session's frames are dropped for the rest of the page's life |
| `seq` | counter within the session | integer, must rise; a lower or equal one is dropped |
| `at` | sender clock, ms | within ±120 s of the glasses' clock, else dropped |
| `re` | the id of the newest hello the phone has from this device | must be one of the page's last six hello ids, else dropped. This is what stops frames recorded earlier from being played back to a freshly opened page |
| `ss` | Bakar Drive `RoutingSessionState` name | one of the nine names, else dropped |
| `turn` | Bakar Drive `CarDirection` name | one of the seventeen names, else shown as no arrow |
| `exit` | roundabout exit, 0 if none | integer 0 to 20 |
| `toTurn`, `left` | distances as Bakar Drive formats them | at most 16 characters |
| `next`, `street` | street names | at most 60 characters, control characters removed |
| `secs` | seconds to the destination | integer 0 to 360000 |
| `pct` | route completion | 0 to 100 |
| `sim` | Bakar Drive's demo drive | true shows "Demo route" |

A frame is shown for 4 s after it arrives; after that the turn dims and the page says directions are
paused. Destination coordinates, the destination name and the phone's position are never sent.

### Speed and heading (optional, same frame)

```json
{"m":"nav","sid":"Zx81kq2mP0aa","seq":43,"at":1793580001000,"re":"AbCdEfGhIjKl","nav":null,"gps":{"kmh":50,"hdg":90}}
```

When the phone has a fresh GPS reading it adds `gps` to the same sealed frame, with or without a route.
`kmh` is the ground speed in whole km/h and `hdg` the direction of travel in whole degrees clockwise from
north (0 to 359) or `null`. It exists so the speedometer works even when the glasses are not allowed
location of their own.

| Field | Rule on the phone | Rule on the glasses |
|---|---|---|
| `gps` | left out when there is no reading, the reading is older than 3 s, its speed is missing, negative, not trusted by the phone's own accuracy filter, or above 100 m/s | not an object with a valid `kmh`: the whole `gps` is dropped and the rest of the frame is used as usual |
| `kmh` | `round(m/s × 3.6)`. A zero is sent only when the phone measured zero; nothing is derived or guessed | integer 0 to 360, else `gps` is dropped |
| `hdg` | `null` below 2 m/s (about 7 km/h) or when the phone has no trustworthy course | integer 0 to 359, else `null` (the speed is kept) |

The glasses show the phone's speed while its last `gps` arrived less than 3.5 s ago and the phone is live,
use the glasses' own location otherwise, and show a dash when they have neither. Only speed and heading are
sent; the phone's position never is. A frame without `gps` is byte for byte what it was before, and an older
glasses page ignores the key.

## Brokers

| Broker | Glasses (WebSocket) | Phone (TLS) |
|---|---|---|
| EMQX | `wss://broker.emqx.io:8084/mqtt` | `broker.emqx.io:8883` |
| HiveMQ | `wss://broker.hivemq.com:8884/mqtt` | `broker.hivemq.com:8883` |
| shiftr.io (user and password `public`) | `wss://public.cloud.shiftr.io` | `public.cloud.shiftr.io:8883` |

Both sides use all three at once and drop a repeat of the same payload text.

## Phone side

- Reads Bakar Drive's live navigation through its signature-protected provider (only an app signed like
  Bakar Drive can read it), once a second while a paired device is listening.
- Pairing is opened from the phone app for two minutes. It accepts at most three glasses keys and can
  forget them.
- Each nav frame carries the id of the newest hello from that device (`re`); a pair reply carries the id
  of the hello it answers.
- The phone sender's source stays with the phone app's own private source.

Test vectors for both sides: `tests/vectors.json`, made by `tests/make-vectors.cjs`.
