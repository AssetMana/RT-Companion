-- RT Systems Companion: a CraftOS for the phone.
--
-- The Pocket OS (rt_pocket.lua and everything it loads) runs here
-- unchanged, on fengari in the phone's browser (companion/public/worker.js).
-- This file gives it what a pocket computer gives it -- fs, os (events,
-- timers, the clock), term (a 26 x 20 screen with CC: Graphics' pixel
-- modes), rednet (to the RT Systems server, through the companion relay),
-- colors, keys, textutils, window, peripheral and the rest -- each backed
-- by the worker's host_* functions:
--
--   host_fs(op, path, ...)     the pocket's files: the release's own (read
--                              from the relay, as needed) under the phone's
--                              own (kept in the browser)
--   host_send(json)            a request to the server
--   host_timer(id, secs)       a timer event later; host_cancel(id)
--   host_draw(x, y, rows)      pixels (CC: Graphics drawPixels)
--   host_palette(i, r, g, b)   a palette colour (0-1)
--   host_mode(m)               the graphics mode (0, 1, 2)
--   host_text(y, text, fg, bg) a row of the text screen (mode 0)
--   host_epoch(), host_clock() the time (ms), seconds since starting
--   host_log(s)                the browser's console
--   host_size()                the screen's width and height, in cells
--   host_sound(name, vol, p)   a sound (the page plays it: app.js)
--   host_device()              32 random hex characters (this phone's id is made from it once)
--   host_kind()                "iPhone", "iPad", "Android phone", "Android tablet" or "phone"
--   host_badge(n)              the Home Screen icon's count (the page sets it)
--   host_awake(on)             keep the phone's screen on (a game is open)
--   host_calendar(json)        an event for the phone's calendar (the page asks: Add)
--   host_share(json)           an event's link, to share (the page asks: Share)
--
-- The worker starts it with rt_boot() and then hands it every event with
-- rt_event(name, ...): the program runs until it waits for the next.

local host_fs, host_send, host_timer, host_cancel = host_fs, host_send, host_timer, host_cancel
local host_draw, host_palette, host_mode, host_text = host_draw, host_palette, host_mode, host_text
local host_epoch, host_clock, host_log, host_keyboard = host_epoch, host_clock, host_log, host_keyboard
local host_size, host_sound, host_device, host_kind, host_badge, host_awake = host_size, host_sound, host_device, host_kind, host_badge, host_awake
local host_calendar, host_share = host_calendar, host_share

-- (the screen: a pocket's 26 wide, and as tall as the phone has room
-- for -- 20 rows, a pocket's own, up to 40)
local W, H = host_size()
local CW, CH = 6, 9

----------------------------------------------------------------- bit32 (Lua 5.3 has the operators)
bit32 = {
  band = function(a, b, ...) local r = (math.floor(a) & math.floor(b)) & 0xFFFFFFFF; for _, c in ipairs({...}) do r = r & math.floor(c) end; return r end,
  bor = function(a, b, ...) local r = (math.floor(a) | math.floor(b or 0)) & 0xFFFFFFFF; for _, c in ipairs({...}) do r = r | math.floor(c) end; return r end,
  bxor = function(a, b, ...) local r = (math.floor(a) ~ math.floor(b or 0)) & 0xFFFFFFFF; for _, c in ipairs({...}) do r = r ~ math.floor(c) end; return r end,
  bnot = function(a) return (~math.floor(a)) & 0xFFFFFFFF end,
  lshift = function(a, n) return (math.floor(a) << n) & 0xFFFFFFFF end,
  rshift = function(a, n) return (math.floor(a) & 0xFFFFFFFF) >> n end,
  arshift = function(a, n) a = math.floor(a) & 0xFFFFFFFF; if a >= 0x80000000 then a = a - 0x100000000 end; return (a >> n | (a < 0 and ~(0xFFFFFFFF >> n) or 0)) & 0xFFFFFFFF end,
  btest = function(a, b) return (math.floor(a) & math.floor(b)) ~= 0 end,
  extract = function(n, f, w) w = w or 1; return (math.floor(n) >> f) & ((1 << w) - 1) end,
}
-- (Lua 5.2 names CC's programs still use)
unpack = unpack or table.unpack
loadstring = loadstring or function(s, name) return load(s, name) end
math.pow = math.pow or function(a, b) return a ^ b end
math.mod = math.mod or math.fmod
table.getn = table.getn or function(t) return #t end
math.ldexp = math.ldexp or function(m, e) return m * 2 ^ e end

----------------------------------------------------------------- colors, keys
colors = {white = 1, orange = 2, magenta = 4, lightBlue = 8, yellow = 16, lime = 32, pink = 64, gray = 128, lightGray = 256,
  cyan = 512, purple = 1024, blue = 2048, brown = 4096, green = 8192, red = 16384, black = 32768}
colors.grey, colors.lightGrey = colors.gray, colors.lightGray
colours = colors
colors.fromBlit = function(ch) local n = tonumber(ch, 16); return n and (1 << n) or nil end
colors.toBlit = function(c) local n = 0; c = math.floor(c); while c > 1 do c = c >> 1; n = n + 1 end; return ("0123456789abcdef"):sub(n + 1, n + 1) end
colors.combine = function(...) local r = 0; for _, c in ipairs({...}) do r = r | math.floor(c) end; return r end
colors.subtract = function(a, ...) a = math.floor(a); for _, c in ipairs({...}) do a = a & ~math.floor(c) end; return a end
colors.test = function(a, b) return (math.floor(a) & math.floor(b)) == math.floor(b) end
colors.packRGB = function(r, g, b) return math.floor(r * 255) * 65536 + math.floor(g * 255) * 256 + math.floor(b * 255) end
colors.unpackRGB = function(n) return (n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255 end
local function idxOf(c) local n = 0; c = math.floor(c); while c > 1 do c = c >> 1; n = n + 1 end; return n end

keys = {a = 30, b = 48, c = 46, d = 32, e = 18, f = 33, g = 34, h = 35, i = 23, j = 36, k = 37, l = 38, m = 50, n = 49, o = 24, p = 25,
  q = 16, r = 19, s = 31, t = 20, u = 22, v = 47, w = 17, x = 45, y = 21, z = 44,
  zero = 11, one = 2, two = 3, three = 4, four = 5, five = 6, six = 7, seven = 8, eight = 9, nine = 10,
  enter = 28, backspace = 14, tab = 15, space = 57, up = 200, down = 208, left = 203, right = 205, home = 199, ["end"] = 207,
  pageUp = 201, pageDown = 209, delete = 211, insert = 210, leftShift = 42, rightShift = 54, leftCtrl = 29, rightCtrl = 157,
  leftAlt = 56, rightAlt = 184, numPadEnter = 156, escape = 1, minus = 12, equals = 13, period = 52, comma = 51, slash = 53}
keys.getName = function(k) for n, v in pairs(keys) do if v == k and type(v) == "number" then return n end end end

----------------------------------------------------------------- JSON (the relay's tongue)
-- (a table's number keys that aren't a plain list go as "\0" .. n, so
-- they come back as numbers: the server does the same)
local json = {}
do
  local function enc(v, seen)
    local t = type(v)
    if t == "nil" then return "null"
    elseif t == "boolean" then return v and "true" or "false"
    elseif t == "number" then
      if v ~= v or v == math.huge or v == -math.huge then return "null" end
      if math.type(v) == "integer" or (v == math.floor(v) and math.abs(v) < 1e15) then return string.format("%d", v) end
      return string.format("%.14g", v)
    elseif t == "string" then
      return '"' .. v:gsub('[%c"\\\128-\255]', function(ch)
        local map = {['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t'}
        return map[ch] or string.format("\\u%04x", ch:byte())
      end) .. '"'
    elseif t == "table" then
      seen = seen or {}
      if seen[v] then return "null" end
      seen[v] = true
      local n = #v
      local isArray = n > 0
      if isArray then for k in pairs(v) do if math.type(k) ~= "integer" or k < 1 or k > n then isArray = false; break end end end
      local out = {}
      if isArray then
        for i = 1, n do out[i] = enc(v[i], seen) end
        seen[v] = nil
        return "[" .. table.concat(out, ",") .. "]"
      end
      for k, x in pairs(v) do
        local tx = type(x)
        if tx ~= "function" and tx ~= "thread" and tx ~= "userdata" then
          local key = type(k) == "number" and ("\0" .. tostring(k)) or (type(k) == "string" and k or nil)
          if key then out[#out + 1] = enc(key) .. ":" .. enc(x, seen) end
        end
      end
      seen[v] = nil
      return "{" .. table.concat(out, ",") .. "}"
    end
    return "null"
  end
  local function dec(s)
    local i = 1
    local function ws() i = s:find("[^ \t\r\n]", i) or (#s + 1) end
    local val
    local function str()
      i = i + 1
      local out = {}
      while true do
        local c = s:sub(i, i)
        if c == "" then error("unterminated string") end
        if c == '"' then i = i + 1; break end
        if c == "\\" then
          local e = s:sub(i + 1, i + 1)
          if e == "u" then
            local code = tonumber(s:sub(i + 2, i + 5), 16) or 63
            out[#out + 1] = code < 256 and string.char(code) or "?"
            i = i + 6
          else
            local map = {['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t'}
            out[#out + 1] = map[e] or e; i = i + 2
          end
        else
          local j = s:find('["\\]', i) or (#s + 1)
          out[#out + 1] = s:sub(i, j - 1); i = j
        end
      end
      return table.concat(out)
    end
    function val()
      ws()
      local c = s:sub(i, i)
      if c == "{" then
        i = i + 1; local t = {}
        ws(); if s:sub(i, i) == "}" then i = i + 1; return t end
        while true do
          ws(); local k = str(); ws()
          i = i + 1
          local v = val()
          if k:sub(1, 1) == "\0" then k = tonumber(k:sub(2)) or k end
          t[k] = v; ws()
          local d = s:sub(i, i); i = i + 1
          if d == "}" then return t elseif d ~= "," then error("expected ,") end
        end
      elseif c == "[" then
        i = i + 1; local t = {}
        ws(); if s:sub(i, i) == "]" then i = i + 1; return t end
        local n = 0
        while true do
          n = n + 1; t[n] = val(); ws()
          local d = s:sub(i, i); i = i + 1
          if d == "]" then return t elseif d ~= "," then error("expected ,") end
        end
      elseif c == '"' then return str()
      elseif s:sub(i, i + 3) == "true" then i = i + 4; return true
      elseif s:sub(i, i + 4) == "false" then i = i + 5; return false
      elseif s:sub(i, i + 3) == "null" then i = i + 4; return nil
      else
        local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
        if not num or num == "" then error("bad value") end
        i = i + #num
        return math.tointeger(tonumber(num)) or tonumber(num)
      end
    end
    local ok, v = pcall(val)
    if ok then return v end
  end
  json.enc, json.dec = enc, dec
end
RT_JSON = json

----------------------------------------------------------------- textutils
textutils = {}
local function ser(v, opts, tracking, indent)
  local t = type(v)
  if t == "string" then return string.format("%q", v) end
  if t == "number" then
    if v ~= v then return "0/0" elseif v == math.huge then return "1/0" elseif v == -math.huge then return "-1/0" end
    if math.type(v) == "integer" then return tostring(v) end
    if v == math.floor(v) and math.abs(v) < 2 ^ 53 then return string.format("%d", v) end
    return string.format("%.17g", v)
  end
  if t == "boolean" or t == "nil" then return tostring(v) end
  if t == "table" then
    tracking = tracking or {}
    if tracking[v] ~= nil then
      if tracking[v] == false then
        if not (opts and opts.allow_repetitions) then error("Cannot serialize table with repeated entries", 0) end
      else error("Cannot serialize table with recursive entries", 0) end
    end
    tracking[v] = true
    local parts = {}
    local n = #v
    for i = 1, n do parts[#parts + 1] = ser(v[i], opts, tracking) end
    for k, val in pairs(v) do
      if not (math.type(k) == "integer" and k >= 1 and k <= n) then
        if type(val) == "function" or type(k) == "function" then
          if not (opts and opts.lenient) then error("Cannot serialize type function", 0) end
        elseif type(k) == "string" and k:match("^[%a_][%w_]*$") then parts[#parts + 1] = k .. "=" .. ser(val, opts, tracking)
        else parts[#parts + 1] = "[" .. ser(k, opts, tracking) .. "]=" .. ser(val, opts, tracking) end
      end
    end
    tracking[v] = false
    return "{" .. table.concat(parts, ",") .. "}"
  end
  if opts and opts.lenient then return "nil" end
  error("Cannot serialize type " .. t, 0)
end
textutils.serialize = function(v, opts) return ser(v, opts) end
textutils.serialise = textutils.serialize
textutils.unserialize = function(s)
  if type(s) ~= "string" then return nil end
  local f = load("return " .. s, "unserialize", "t", {})
  if not f then return nil end
  local ok, r = pcall(f)
  if ok then return r end
end
textutils.unserialise = textutils.unserialize
textutils.serializeJSON = function(v) return json.enc(v) end
textutils.serialiseJSON = textutils.serializeJSON
textutils.unserializeJSON = function(s) return json.dec(s) end
textutils.unserialiseJSON = textutils.unserializeJSON
textutils.formatTime = function(t, h24)
  local hour = math.floor(t); local min = math.floor((t - hour) * 60)
  if h24 then return string.format("%d:%02d", hour, min) end
  local ap = hour >= 12 and "PM" or "AM"; hour = hour % 12; if hour == 0 then hour = 12 end
  return string.format("%d:%02d %s", hour, min, ap)
end
textutils.urlEncode = function(s) return (tostring(s):gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", c:byte()) end)) end
textutils.slowPrint = function(s) print(s) end
textutils.tabulate = function() end
textutils.pagedTabulate = function() end
textutils.pagedPrint = function(s) print(s) end

----------------------------------------------------------------- fs: the release's files under the phone's own
local function norm(p) p = ("/" .. tostring(p)):gsub("/+", "/"); if #p > 1 then p = p:gsub("/$", "") end; return p end
fs = {}
function fs.combine(a, ...) local p = a; for _, b in ipairs({...}) do p = p .. "/" .. b end; return (norm(p)):sub(2) end
function fs.getDir(p) local n = norm(p); return (n:match("^(.*)/[^/]*$") or ""):sub(2) end
function fs.getName(p) local n = norm(p):match("([^/]*)$"); return n == "" and "root" or n end
function fs.exists(p) return host_fs("exists", norm(p)) end
function fs.isDir(p) return host_fs("isDir", norm(p)) end
function fs.isReadOnly() return false end
function fs.makeDir(p) host_fs("makeDir", norm(p)) end
function fs.delete(p) host_fs("delete", norm(p)) end
function fs.list(p)
  local s = host_fs("list", norm(p))
  local out = {}
  if s and s ~= "" then for name in s:gmatch("[^\n]+") do out[#out + 1] = name end end
  table.sort(out)
  return out
end
function fs.getSize(p) return host_fs("size", norm(p)) or 0 end
function fs.getFreeSpace() return 64 * 1024 * 1024 end
function fs.getCapacity() return 100 * 1024 * 1024 end
function fs.getDrive(p) return fs.exists(p) and "hdd" or nil end
function fs.attributes(p) return {size = fs.getSize(p), isDir = fs.isDir(p), isReadOnly = false, modified = host_epoch(), created = host_epoch()} end
local function readAll(p) return host_fs("read", norm(p)) end
function fs.copy(a, b)
  if fs.isDir(a) then
    fs.makeDir(b)
    for _, n in ipairs(fs.list(a)) do fs.copy(fs.combine(a, n), fs.combine(b, n)) end
    return
  end
  local c = readAll(a)
  if c == nil then error("/" .. norm(a):sub(2) .. ": No such file", 0) end
  host_fs("write", norm(b), c)
end
function fs.move(a, b) fs.copy(a, b); fs.delete(a) end
function fs.find(pattern)
  local out = {}
  local s = host_fs("find", pattern)
  if s and s ~= "" then for name in s:gmatch("[^\n]+") do out[#out + 1] = name end end
  return out
end
function fs.open(p, mode)
  p = norm(p)
  mode = mode or "r"
  if mode:sub(1, 1) == "r" then
    local c = readAll(p)
    if c == nil then return nil, "/" .. p:sub(2) .. ": No such file" end
    local pos = 1
    local h = {}
    h.readAll = function() local r = c:sub(pos); pos = #c + 1; return r end
    h.readLine = function(withNl)
      if pos > #c then return nil end
      local e = c:find("\n", pos, true) or (#c + 1)
      local l = c:sub(pos, withNl and e or e - 1); pos = e + 1; return l
    end
    h.read = function(n)
      if pos > #c then return nil end
      if n == nil and mode == "rb" then local b = c:byte(pos); pos = pos + 1; return b end
      n = n or 1
      local r = c:sub(pos, pos + n - 1); pos = pos + n; return r
    end
    h.seek = function(whence, off)
      whence, off = whence or "cur", off or 0
      if whence == "set" then pos = off + 1 elseif whence == "end" then pos = #c + off + 1 else pos = pos + off end
      return pos - 1
    end
    h.close = function() end
    return h
  end
  local buf = {}
  if mode:sub(1, 1) == "a" then buf[1] = readAll(p) or "" end
  local h = {}
  local function store() host_fs("write", p, table.concat(buf)) end
  h.write = function(s) if type(s) == "number" and mode:find("b") then buf[#buf + 1] = string.char(s) else buf[#buf + 1] = tostring(s) end end
  h.writeLine = function(s) buf[#buf + 1] = tostring(s) .. "\n" end
  h.flush = store
  h.close = store
  return h
end

-- dofile / loadfile read through fs
function loadfile(p, mode, env)
  if type(mode) == "table" and env == nil then env, mode = mode, nil end
  local c = readAll(norm(p))
  if c == nil then return nil, "File not found" end
  return load(c, "@/" .. norm(p):sub(2), mode or "t", env or _G)
end
function dofile(p) local f, err = loadfile(p); if not f then error(err .. ": " .. tostring(p), 2) end; return f() end

----------------------------------------------------------------- os
local timers, nextTimer = {}, 1
local queue = {}
os.epoch = function(kind) return host_epoch(kind) end
os.clock = function() return host_clock() end
local hostTime = os.time
os.time = function(t)
  if t == "utc" or t == "local" or t == "ingame" or t == nil then
    if t == nil or t == "ingame" then
      -- (the Minecraft day's hour: kept to the real clock here)
      local d = os.date("*t")
      return d.hour + d.min / 60
    end
    return math.floor(host_epoch() / 1000)
  end
  return hostTime(t)
end
os.day = function() return math.floor(host_epoch() / 86400000) end
os.getComputerID = function() return 1 end
os.computerID = os.getComputerID
os.getComputerLabel = function() return "Phone" end
os.computerLabel = os.getComputerLabel
os.setComputerLabel = function() end
os.startTimer = function(s)
  local id = nextTimer; nextTimer = nextTimer + 1
  timers[id] = true
  host_timer(id, tonumber(s) or 0)
  return id
end
os.cancelTimer = function(id) timers[id] = nil; host_cancel(id) end
os.setAlarm = function() return os.startTimer(3600) end
os.cancelAlarm = os.cancelTimer
os.queueEvent = function(...) queue[#queue + 1] = table.pack(...) end
os.pullEventRaw = function(filter)
  while true do
    local ev = table.pack(coroutine.yield(filter))
    if not filter or ev[1] == filter then return table.unpack(ev, 1, ev.n) end
  end
end
os.pullEvent = function(filter)
  local ev = table.pack(os.pullEventRaw(filter))
  if ev[1] == "terminate" then error("Terminated", 0) end
  return table.unpack(ev, 1, ev.n)
end
function sleep(s)
  local id = os.startTimer(s or 0)
  repeat local _, t = os.pullEvent("timer") until t == id
end
os.sleep = sleep
os.reboot = function() error("rt_reboot", 0) end
os.shutdown = function() error("rt_shutdown", 0) end
os.version = function() return "CraftOS 1.9" end
os.run = function(env, path, ...)
  local f = loadfile(path, nil, setmetatable(env or {}, {__index = _G}))
  if not f then return false end
  return pcall(f, ...)
end
os.loadAPI = function() return false end
_HOST = "ComputerCraft 1.110.0 (RT Systems Companion)"
_CC_DEFAULT_SETTINGS = ""

settings = {}
do
  local S = {}
  settings.get = function(k, d) local v = S[k]; if v == nil then return d end; return v end
  settings.set = function(k, v) S[k] = v end
  settings.unset = function(k) S[k] = nil end
  settings.clear = function() S = {} end
  settings.save = function() return true end
  settings.load = function() return true end
  settings.define = function() end
  settings.getNames = function() local o = {}; for k in pairs(S) do o[#o + 1] = k end; return o end
end

----------------------------------------------------------------- the screen
local PALETTE16 = {0xF0F0F0, 0xF2B233, 0xE57FD8, 0x99B2F2, 0xDEDE6C, 0x7FCC19, 0xF2B2CC, 0x4C4C4C,
  0x999999, 0x4C99B2, 0xB266E5, 0x3366CC, 0x7F664C, 0x57A64E, 0xCC4C4C, 0x111111}
local function newScreen()
  local s = {}
  local cx, cy, fg, bg, blink = 1, 1, colors.white, colors.black, false
  local mode = 0
  local rows, fgs, bgs = {}, {}, {}
  local textDirty = {}
  local function blankRow(y) rows[y], fgs[y], bgs[y] = (" "):rep(W), ("0"):rep(W), ("f"):rep(W); textDirty[y] = true end
  for y = 1, H do blankRow(y) end
  local pal = {}
  for i = 0, 15 do local v = PALETTE16[i + 1]; pal[i] = {(v >> 16) / 255, (v >> 8 & 255) / 255, (v & 255) / 255} end
  s.getSize = function(m) if m and m ~= 0 then return W * CW, H * CH end return W, H end
  s.setCursorPos = function(x, y) cx, cy = math.floor(x), math.floor(y) end
  s.getCursorPos = function() return cx, cy end
  s.setCursorBlink = function(b) blink = b and true or false; host_keyboard(blink) end
  s.getCursorBlink = function() return blink end
  s.setTextColor = function(c) fg = c end
  s.setTextColour = s.setTextColor
  s.getTextColor = function() return fg end
  s.getTextColour = s.getTextColor
  s.setBackgroundColor = function(c) bg = c end
  s.setBackgroundColour = s.setBackgroundColor
  s.getBackgroundColor = function() return bg end
  s.getBackgroundColour = s.getBackgroundColor
  s.isColor = function() return true end
  s.isColour = s.isColor
  local function put(text, f, b)
    text = tostring(text)
    if cy < 1 or cy > H then cx = cx + #text; return end
    local a = cx
    local z = cx + #text - 1
    local s1, s2 = math.max(1, a), math.min(W, z)
    if s1 <= s2 then
      local from, to = s1 - a + 1, s2 - a + 1
      local piece = text:sub(from, to)
      local fp = f and f:sub(from, to) or colors.toBlit(fg):rep(#piece)
      local bp = b and b:sub(from, to) or colors.toBlit(bg):rep(#piece)
      rows[cy] = rows[cy]:sub(1, s1 - 1) .. piece .. rows[cy]:sub(s2 + 1)
      fgs[cy] = fgs[cy]:sub(1, s1 - 1) .. fp .. fgs[cy]:sub(s2 + 1)
      bgs[cy] = bgs[cy]:sub(1, s1 - 1) .. bp .. bgs[cy]:sub(s2 + 1)
      textDirty[cy] = true
    end
    cx = cx + #text
  end
  s.write = function(t) put(t) end
  s.blit = function(t, f, b) put(t, f, b) end
  s.clear = function() for y = 1, H do rows[y] = (" "):rep(W); fgs[y] = colors.toBlit(fg):rep(W); bgs[y] = colors.toBlit(bg):rep(W); textDirty[y] = true end end
  s.clearLine = function() if cy >= 1 and cy <= H then rows[cy] = (" "):rep(W); bgs[cy] = colors.toBlit(bg):rep(W); textDirty[cy] = true end end
  s.scroll = function(n)
    n = math.floor(n or 1)
    if n > 0 then
      for _ = 1, n do table.remove(rows, 1); table.remove(fgs, 1); table.remove(bgs, 1); rows[H], fgs[H], bgs[H] = (" "):rep(W), ("0"):rep(W), colors.toBlit(bg):rep(W) end
    elseif n < 0 then
      for _ = 1, -n do table.remove(rows); table.remove(fgs); table.remove(bgs); table.insert(rows, 1, (" "):rep(W)); table.insert(fgs, 1, ("0"):rep(W)); table.insert(bgs, 1, colors.toBlit(bg):rep(W)) end
    end
    for y = 1, H do textDirty[y] = true end
  end
  s.getLine = function(y) return rows[y], fgs[y], bgs[y] end
  s.setPaletteColour = function(c, r, g, b)
    local i = (type(c) == "number" and c >= 16 and mode == 2) and math.floor(c) or idxOf(c)
    if g == nil then local v = math.floor(r); r, g, b = (v >> 16) / 255, (v >> 8 & 255) / 255, (v & 255) / 255 end
    pal[i] = {r, g, b}
    host_palette(i, r, g, b)
  end
  s.setPaletteColor = s.setPaletteColour
  s.getPaletteColour = function(c)
    local i = (type(c) == "number" and c >= 16) and math.floor(c) or idxOf(c)
    local p = pal[i] or {0, 0, 0}
    return p[1], p[2], p[3]
  end
  s.getPaletteColor = s.getPaletteColour
  s.nativePaletteColour = function(c) local v = PALETTE16[idxOf(c) + 1]; return (v >> 16) / 255, (v >> 8 & 255) / 255, (v & 255) / 255 end
  s.nativePaletteColor = s.nativePaletteColour
  -- CC: Graphics
  s.setGraphicsMode = function(m)
    if m == true then m = 1 elseif m == false or m == nil then m = 0 end
    m = math.floor(m)
    if m < 0 or m > 2 then error("bad graphics mode", 0) end
    mode = m
    host_mode(m)
    if m == 0 then for y = 1, H do textDirty[y] = true end end
  end
  s.getGraphicsMode = function() return mode ~= 0 and mode or false end
  s.setFrozen = function() end
  s.getFrozen = function() return false end
  s.drawPixels = function(x, y, data)
    if type(data) ~= "table" then error("bad pixels", 0) end
    host_draw(math.floor(x), math.floor(y), data)
  end
  s.setPixel = function(x, y, c) host_draw(math.floor(x), math.floor(y), {string.char(math.floor(c) % 256)}) end
  -- what the worker shows of the text screen (mode 0), after each event
  s._flushText = function()
    if mode ~= 0 then return end
    for y = 1, H do if textDirty[y] then host_text(y, rows[y], fgs[y], bgs[y]); textDirty[y] = false end end
  end
  return s
end
local native = newScreen()
local current = native
term = setmetatable({}, {__index = function(_, k) local v = current[k]; return v end})
term.redirect = function(t) local old = current; current = t; return old end
term.current = function() return current end
term.native = function() return native end
RT_NATIVE_SCREEN = native

----------------------------------------------------------------- window (CC's window API)
window = {}
function window.create(parent, x, y, w, h, visible)
  local win = {}
  local vis = visible ~= false
  local cx, cy, fg, bg, blink = 1, 1, colors.white, colors.black, false
  local rows, fgs, bgs = {}, {}, {}
  for r = 1, h do rows[r], fgs[r], bgs[r] = (" "):rep(w), ("0"):rep(w), ("f"):rep(w) end
  local function copyRow(r)
    if not vis or r < 1 or r > h then return end
    local px, py = parent.getCursorPos()
    parent.setCursorPos(x, y + r - 1)
    parent.blit(rows[r], fgs[r], bgs[r])
    parent.setCursorPos(px, py)
  end
  local function copyAll() for r = 1, h do copyRow(r) end end
  local function put(text, f, b)
    text = tostring(text)
    if cy >= 1 and cy <= h then
      local a, z = cx, cx + #text - 1
      local s1, s2 = math.max(1, a), math.min(w, z)
      if s1 <= s2 then
        local from, to = s1 - a + 1, s2 - a + 1
        local piece = text:sub(from, to)
        rows[cy] = rows[cy]:sub(1, s1 - 1) .. piece .. rows[cy]:sub(s2 + 1)
        fgs[cy] = fgs[cy]:sub(1, s1 - 1) .. (f and f:sub(from, to) or colors.toBlit(fg):rep(#piece)) .. fgs[cy]:sub(s2 + 1)
        bgs[cy] = bgs[cy]:sub(1, s1 - 1) .. (b and b:sub(from, to) or colors.toBlit(bg):rep(#piece)) .. bgs[cy]:sub(s2 + 1)
        copyRow(cy)
      end
    end
    cx = cx + #text
  end
  win.write = function(t) put(t) end
  win.blit = function(t, f, b) put(t, f, b) end
  win.clear = function() for r = 1, h do rows[r], fgs[r], bgs[r] = (" "):rep(w), colors.toBlit(fg):rep(w), colors.toBlit(bg):rep(w) end; copyAll() end
  win.clearLine = function() if cy >= 1 and cy <= h then rows[cy], bgs[cy] = (" "):rep(w), colors.toBlit(bg):rep(w); copyRow(cy) end end
  win.getCursorPos = function() return cx, cy end
  win.setCursorPos = function(nx, ny) cx, cy = math.floor(nx), math.floor(ny); if vis and blink then parent.setCursorPos(x + cx - 1, y + cy - 1) end end
  win.setCursorBlink = function(b) blink = b; if vis then parent.setCursorBlink(b) end end
  win.getCursorBlink = function() return blink end
  win.isColor = function() return true end
  win.isColour = win.isColor
  win.setTextColor = function(c) fg = c end
  win.setTextColour = win.setTextColor
  win.getTextColor = function() return fg end
  win.getTextColour = win.getTextColor
  win.setBackgroundColor = function(c) bg = c end
  win.setBackgroundColour = win.setBackgroundColor
  win.getBackgroundColor = function() return bg end
  win.getBackgroundColour = win.getBackgroundColor
  win.getSize = function() return w, h end
  win.scroll = function(n)
    for _ = 1, n do table.remove(rows, 1); table.remove(fgs, 1); table.remove(bgs, 1); rows[h], fgs[h], bgs[h] = (" "):rep(w), ("0"):rep(w), colors.toBlit(bg):rep(w) end
    copyAll()
  end
  win.setVisible = function(v) vis = v and true or false; if vis then copyAll() end end
  win.isVisible = function() return vis end
  win.redraw = copyAll
  win.restoreCursor = function() if vis then parent.setCursorPos(x + cx - 1, y + cy - 1); parent.setCursorBlink(blink) end end
  win.getPosition = function() return x, y end
  win.getLine = function(r) return rows[r], fgs[r], bgs[r] end
  win.reposition = function(nx, ny, nw, nh, np)
    if np then parent = np end
    x, y = nx or x, ny or y
    if nw and nh then
      local nr, nf, nb = {}, {}, {}
      for r = 1, nh do
        local o = rows[r] or (" "):rep(nw)
        nr[r] = (o .. (" "):rep(nw)):sub(1, nw)
        nf[r] = ((fgs[r] or "") .. ("0"):rep(nw)):sub(1, nw)
        nb[r] = ((bgs[r] or "") .. colors.toBlit(bg):rep(nw)):sub(1, nw)
      end
      rows, fgs, bgs, w, h = nr, nf, nb, nw, nh
    end
    copyAll()
  end
  for _, k in ipairs({"setPaletteColour", "setPaletteColor", "getPaletteColour", "getPaletteColor", "nativePaletteColour", "nativePaletteColor"}) do
    win[k] = function(...) return parent[k](...) end
  end
  return win
end

----------------------------------------------------------------- the network: the server, through the relay
local SERVER = 1
rednet = {}
rednet.open = function() end
rednet.close = function() end
rednet.isOpen = function() return true end
rednet.host = function() end
rednet.unhost = function() end
rednet.lookup = function(proto, name) if name then return SERVER end return SERVER end
-- (this phone's id, made once and kept: every request carries it, so the
-- server knows a phone its owner let in from a new one)
RT_ON_PHONE = true -- (the pocket's code can tell it's on a real phone)
local PHONE_ID_FILE = "/.rtsystems_phone_id"
local phoneId
local function deviceId()
  if phoneId then return phoneId end
  local f = fs.open(PHONE_ID_FILE, "r")
  if f then phoneId = f.readAll(); f.close() end
  if type(phoneId) ~= "string" or not phoneId:match("^%x+$") or #phoneId < 16 then
    phoneId = host_device and host_device() or nil
    if phoneId then local w = fs.open(PHONE_ID_FILE, "w"); if w then w.write(phoneId); w.close() end end
  end
  return phoneId
end
-- (the page asks for it, to sign this phone up for alerts: worker.js)
function rt_phone_id() return deviceId() end
-- (an alert tapped: the pocket's Home opens its app on it -- pocket/home.lua)
function rt_open(kind, text, ref, link)
  if type(kind) == "string" then RT_PENDING_OPEN = {kind = kind, text = text, ref = tonumber(ref) or ref, at = os.clock(), link = link and true or nil} end
end
-- (the Home Screen icon's count: pocket/home.lua tells it, the page shows it)
RT_PHONE_BADGE = function(n) if host_badge then host_badge(tonumber(n) or 0) end end
-- (an event, into the phone's own calendar: the page asks first -- apps/events_pocket.lua)
RT_PHONE_CALENDAR = function(ev) if host_calendar and type(ev) == "table" then host_calendar(json.enc(ev)) end end
-- (an event, shared as a link that opens RT Pocket on it -- apps/events_pocket.lua)
RT_PHONE_SHARE = function(s) if host_share and type(s) == "table" then host_share(json.enc(s)) end end
-- (a game open: the phone's screen stays on -- pocket/home.lua)
RT_PHONE_AWAKE = function(on) if host_awake then host_awake(on and true or false) end end
rednet.send = function(id, msg, proto)
  if type(msg) == "table" then
    local copy = {}
    for k, v in pairs(msg) do copy[k] = v end
    copy._phone = deviceId()
    if msg.type == "login" or msg.type == "register" then copy._phoneKind = host_kind and host_kind() or nil end
    host_send(json.enc(copy))
  end
  return true
end
rednet.broadcast = function() end
rednet.receive = function(proto, timeout)
  local t = timeout and os.startTimer(timeout)
  while true do
    local ev, a, b, c = os.pullEvent()
    if ev == "rednet_message" and (not proto or c == proto) then return a, b, c end
    if ev == "timer" and a == t then return nil end
  end
end
-- (the phone's modem: always there, always wireless)
local modem = {isWireless = function() return true end, open = function() end, close = function() end, isOpen = function() return true end,
  transmit = function() end, closeAll = function() end}
peripheral = {
  getNames = function() return {"back"} end,
  getType = function(n) if n == "back" then return "modem" end end,
  hasType = function(n, t) return n == "back" and t == "modem" end,
  isPresent = function(n) return n == "back" end,
  wrap = function(n) if n == "back" then return modem end end,
  find = function(t) if t == "modem" then return modem end end,
  call = function() end,
  getMethods = function() return {} end,
}
gps = {locate = function() return nil end, CHANNEL_GPS = 65534}
-- (CC: Graphics' own sounds, to whoever has the screen open: here, the
-- phone's speaker -- lib/sound.lua plays the chimes and game sounds
-- through it, and the pocket's Sounds setting still turns them off)
ccgraphics = {playSound = function(name, vol, pitch)
  host_sound(tostring(name or ""), tonumber(vol) or 0.6, tonumber(pitch) or 1)
  return true
end}
http = nil
pocket = {equipBack = function() return false, "Not on a phone" end, unequipBack = function() return false end}
disk = {isPresent = function() return false end, hasData = function() return false end, getMountPath = function() return nil end}
parallel = {}
function parallel.waitForAny(...)
  local fns = {...}
  local cos, filters = {}, {}
  for i, f in ipairs(fns) do cos[i] = coroutine.create(f) end
  local ev = {n = 0}
  while true do
    for i, co in ipairs(cos) do
      if co and (filters[i] == nil or filters[i] == ev[1] or ev[1] == "terminate") then
        local ok, f = coroutine.resume(co, table.unpack(ev, 1, ev.n))
        if not ok then error(f, 0) end
        filters[i] = f
        if coroutine.status(co) == "dead" then return i end
      end
    end
    ev = table.pack(coroutine.yield())
  end
end
function parallel.waitForAll(...)
  local fns = {...}
  local cos, filters, alive = {}, {}, #fns
  for i, f in ipairs(fns) do cos[i] = coroutine.create(f) end
  local ev = {n = 0}
  while alive > 0 do
    for i, co in ipairs(cos) do
      if co and (filters[i] == nil or filters[i] == ev[1] or ev[1] == "terminate") then
        local ok, f = coroutine.resume(co, table.unpack(ev, 1, ev.n))
        if not ok then error(f, 0) end
        filters[i] = f
        if coroutine.status(co) == "dead" then cos[i] = false; alive = alive - 1 end
      end
    end
    if alive > 0 then ev = table.pack(coroutine.yield()) end
  end
end

----------------------------------------------------------------- printing
function write(s) s = tostring(s); term.write(s); return 1 end
function print(...)
  local t = {}
  for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
  local s = table.concat(t, " ")
  host_log(s)
  return 1
end
function printError(...) local t = {}; for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end; host_log("error: " .. table.concat(t, " ")) end
function read() return "" end

----------------------------------------------------------------- running the pocket
local PROGRAM = "rt_pocket.lua"
shell = {
  getRunningProgram = function() return PROGRAM end,
  run = function(path, ...)
    -- (the pocket runs itself again after an update: the newest copy)
    local f = loadfile(path, nil, setmetatable({shell = shell}, {__index = _G}))
    if not f then return false end
    f(...)
    return true
  end,
  resolve = function(p) return p end,
  path = function() return "" end,
  dir = function() return "" end,
  exit = function() end,
  openTab = function() return 1 end,
  switchTab = function() end,
  getCompletionInfo = function() return {} end,
}
multishell = nil

local main, filter, finished
function rt_boot()
  main = coroutine.create(function()
    local f, err = loadfile(PROGRAM, nil, setmetatable({shell = shell}, {__index = _G, __newindex = _G}))
    if not f then error("Couldn't load the Pocket OS: " .. tostring(err), 0) end
    return f()
  end)
  return rt_event()
end
local function resume(...)
  local ok, f = coroutine.resume(main, ...)
  if not ok then finished = tostring(f); host_log("stopped: " .. finished); return finished end
  if coroutine.status(main) == "dead" then finished = "ended"; return finished end
  filter = f
end
-- one event in; it runs until it waits again. -> nil, or why it stopped
function rt_event(name, ...)
  if finished then return finished end
  if name == "timer" then
    local id = ...
    if not timers[id] then return end
    timers[id] = nil
  end
  local r
  if name == nil then r = resume()
  elseif filter == nil or filter == name or name == "terminate" then r = resume(name, ...) end
  -- (and whatever it queued for itself)
  local guard = 0
  while not r and #queue > 0 and guard < 200 do
    guard = guard + 1
    local ev = table.remove(queue, 1)
    if filter == nil or filter == ev[1] or ev[1] == "terminate" then r = resume(table.unpack(ev, 1, ev.n)) end
  end
  native._flushText()
  return r
end
-- a message from the server (as rednet would have it)
function rt_message(text)
  local msg = json.dec(text)
  if type(msg) ~= "table" then return end
  return rt_event("rednet_message", SERVER, msg, "rtsystems")
end
