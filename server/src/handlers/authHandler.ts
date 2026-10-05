import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import {
  formatClientOpcode,
  formatServerOpcode,
  formatStageId,
  formatU32Hex,
  logger,
} from "../utils/logger.ts";
import {
  buildMultiSvrNSmartStream,
  buildMultiSvrSmartStream,
  type SsdCacheEntry,
} from "../resources/archive.ts";
import type { UserRecord } from "../db/database.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { sendChannelListAndLoads } from "./channelHandler.ts";

function isKnownSsdCacheValue(
  state: WorldState,
  ssd: SsdCacheEntry | undefined,
  clientValue: number
): boolean {
  if (clientValue === 0 || !ssd) {
    return true;
  }
  if (
    clientValue === ssd.adler32Zero ||
    clientValue === ssd.diskAdler32Zero ||
    clientValue === ssd.crc32 ||
    clientValue === ssd.rawCrc32 ||
    clientValue === ssd.uncompressedCrc32
  ) {
    return true;
  }
  // Also accept any valid disk .ssd checksum when legacy callers pass 5-tuple in alternate order
  for (const entry of state.resources.ssdFiles.values()) {
    if (
      clientValue === entry.adler32Zero ||
      clientValue === entry.diskAdler32Zero ||
      clientValue === entry.crc32
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Builds S->C 1 (`CMultiServer::sub_5D7E8E` at `0x005D7E8E`) for `multisvr.ssd` (`sub_5D782C`)
 * and optional `multisvrn.ssd` (`sub_5D79AE` when feature 68 `sub_5CDBD9(68)` is active).
 */
export function buildMultiServerSsdPacket(
  state: WorldState,
  sendMultiSvrStream: boolean,
  sendMultiSvrNStream: boolean = false
): PacketWriter {
  const w1 = new PacketWriter(ServerOpcode.MultiServerSsd);
  if (!sendMultiSvrStream) {
    w1.writeU8(0);
  } else {
    w1.writeU8(1);
    const msWriter = buildMultiSvrSmartStream(state.config.publicIp, state.config.tcpPort);
    w1.writeSmartStream(msWriter, true);
  }

  if (state.config.enabledFeatures.has(68) || sendMultiSvrNStream) {
    if (!sendMultiSvrNStream) {
      w1.writeU8(0);
    } else {
      w1.writeU8(1);
      const msnWriter = buildMultiSvrNSmartStream(state.config.publicIp, state.config.tcpPort);
      w1.writeSmartStream(msnWriter, true);
    }
  }

  return w1;
}

/**
 * Handles pre-login cache verification (`C->S 0`, `CFxApp::sub_5A1E40` at `0x005A1E40`):
 * Client sends the fields written at sub_5A1E40 (in this order):
 *   1. `u32` dynamic-image cache context (`dword_92AAF8[2]`); CDynamicImgContext's
 *      constructor initializes it to 0. The server's default ConnectHello has
 *      `extraFlag=0`, so this flow sends the zero sentinel, not the disk Adler-32.
 *   2. `u32` system-string cache value (`*(_DWORD *)(dword_929D68 + 88)`)
 *   3. `u32` multisvr cache value (`*(_DWORD *)(dword_92D9EC + 108)`; zero unless
 *      a local `multisvr.ssd` is loaded, otherwise its Adler-32)
 *   4. `u32` filter-string cache value (`sub_5C8224(dword_974D94)`)
 *   5. (if `sub_5CDBF2(4) != 0`) `u32` multisvrn cache Adler-32 (`*(_DWORD *)(dword_92D9EC + 112)`)
 *
 * Server replies (`CLoginStage::sub_567400` at `0x00567400`):
 *   - `S->C 189` (`sub_49E093` at `0x0049E093`): `u8 hasStream` + `[CISmartStream fxdynimginfo.ssd]` (`sub_49DF97`)
 *   - `S->C 2`   (`sub_5D00B9` at `0x005D00B9`): `u8 hasStream` + `[CISmartStream csysstr.ssd]` (`sub_5CFE6C`)
 *   - `S->C 1`   (`sub_5D7E8E` at `0x005D7E8E`): `u8 hasStream` + `[CISmartStream multisvr.ssd]` (`sub_5D782C`)
 *                                                 (+ optional `multisvrn.ssd` `sub_5D79AE` if feature 68)
 *   - `S->C 53`  (`sub_5C8BE3` at `0x005C8BE3`): `u8 hasStream` + `[CISmartStream filterstr.ssd]` (`sub_5C89D7`)
 */
export function handlePreLoginSsdCheck(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  const dynamicImgContextValue = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcCsysstr = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcMultisvr = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcFilterstr = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcMultisvrn = reader.remaining >= 4 ? reader.readU32() : 0;

  logger.debug("AuthSync", `Received ${formatClientOpcode(ClientOpcode.PreLoginSsdCheck)}`, {
    sessionId: session.sessionId,
    remoteAddress: session.remoteAddress,
    remotePort: session.remotePort,
    cacheFields: {
      dynamicImageContext: formatU32Hex(dynamicImgContextValue),
      csysstr: formatU32Hex(crcCsysstr),
      multisvr: formatU32Hex(crcMultisvr),
      filterstr: formatU32Hex(crcFilterstr),
      multisvrn: formatU32Hex(crcMultisvrn),
    },
    unreadBytes: reader.remaining,
  });

  const sendSsdReply = (opcode: number, filename: string, clientCacheValue: number): void => {
    const ssd = state.resources.ssdFiles.get(filename);
    const cacheValueIsKnown = isKnownSsdCacheValue(state, ssd, clientCacheValue);
    const hasStream = ssd !== undefined && !cacheValueIsKnown;
    const writer = new PacketWriter(opcode);
    writer.writeU8(hasStream ? 1 : 0);
    if (hasStream && ssd) {
      const stream = new SmartStreamWriter();
      stream.writeRaw(ssd.decompressed);
      writer.writeSmartStream(stream, true);
    }
    logger.debug("AuthSync", `${formatServerOpcode(opcode)} ${filename} sync decision`, {
      sessionId: session.sessionId,
      clientCacheValue: formatU32Hex(clientCacheValue),
      serverChecksum: ssd ? formatU32Hex(ssd.adler32Zero) : "missing",
      hasStream,
      uncompressedBytes: hasStream ? ssd?.decompressed.length : 0,
    });
    session.sendPacket(writer);
  };

  // 1. S->C 189: fxdynimginfo.ssd (`sub_49E093`)
  sendSsdReply(ServerOpcode.DynamicImgInfoSsd, "fxdynimginfo.ssd", dynamicImgContextValue);

  // 2. S->C 2: csysstr.ssd (`sub_5D00B9`)
  sendSsdReply(ServerOpcode.SystemStringSsd, "csysstr.ssd", crcCsysstr);

  // 3. S->C 1: multisvr.ssd / multisvrn.ssd (`sub_5D7E8E`)
  const multisvrEntry = state.resources.ssdFiles.get("multisvr.ssd");
  const multisvrnEntry = state.resources.ssdFiles.get("multisvrn.ssd");
  const multisvrCacheValueKnown = isKnownSsdCacheValue(state, multisvrEntry, crcMultisvr);
  // A custom, non-sentinel cache value means the client has a locally edited multisvr.ssd
  // (usually to point at the test server). Preserve it instead of replacing it with our generated list.
  const preserveClientMultisvr =
    !multisvrCacheValueKnown && crcMultisvr > 0xffff && crcMultisvr !== 0xffffffff;
  const needMultiSvr = !multisvrCacheValueKnown && !preserveClientMultisvr;
  const needMultiSvrN =
    crcMultisvrn !== 0 && !isKnownSsdCacheValue(state, multisvrnEntry, crcMultisvrn);
  logger.debug("AuthSync", "Prepared CMultiServer SSD response", {
    sessionId: session.sessionId,
    clientMultisvrCacheValue: formatU32Hex(crcMultisvr),
    knownServerCacheValue: multisvrCacheValueKnown,
    preserveClientMultisvr,
    sendMultisvr: needMultiSvr,
    sendMultisvrn: needMultiSvrN,
  });
  session.sendPacket(buildMultiServerSsdPacket(state, needMultiSvr, needMultiSvrN));

  // 4. S->C 53: filterstr.ssd (`sub_5C8BE3`)
  sendSsdReply(ServerOpcode.FilterStringSsd, "filterstr.ssd", crcFilterstr);

  session.ssdSynced = true;
  logger.info("AuthSync", "Pre-login client cache synchronization complete", {
    sessionId: session.sessionId,
    ssdSynced: session.ssdSynced,
  });
}

/**
 * Sends S->C 4 (`CLoginStage::sub_567400` -> `sub_566E08`) login result.
 * Exact field layout verified at `0x00567400` and `0x00566E08`. The u16 after the
 * post-exp u8 is stored at `this + 20 + 12*i` by `sub_5ED30E` and returned from that
 * same offset by `sub_5ED43B` for channel level checks, so it carries `user.level`.
 * The preceding u8 is stored separately at `this + 164 + 12*i` by `sub_561F62`;
 * its value mapping and any LoginResult location for `rankFlag` remain unconfirmed, so
 * this reconstruction sends a zero placeholder rather than reusing `user.level`.
 */
export function buildLoginSuccessPacket(state: WorldState, session: ClientSession): PacketWriter {
  const w = new PacketWriter(ServerOpcode.LoginResult);
  w.writeU8(0); // errCode = 0 (success)
  w.writeU16(1); // worldId = 1
  const count = Math.max(1, session.users.length);
  w.writeU8(count);

  const token = state.allocateAuthToken(
    session.users.map((u) => u.username),
    session.netSlotIds,
    session.equippedCharIds,
    session.sessionId
  );

  for (let i = 0; i < count; i++) {
    const user = session.users[i]!;
    session.authTokens[i] = token;

    w.writeU32(user.lucci);
    w.writeU32(user.wins);
    w.writeU32(user.losses);
    w.writeU32(token);
    w.writeString(user.username);
    w.writeU8(user.gender);
    w.writeU32(1); // isRegisteredFlag = 1
    w.writeString(user.nickname || user.username);
    w.writeU32(user.exp);
    w.writeU8(0); // `sub_561F62` stores this separately; its value semantics are unconfirmed.
    w.writeU16(user.level); // `sub_5ED43B` returns this value to the channel-level gate.
    w.writeU8(user.equippedChar); // Local reconstruction mapping; the wire field's identity is unconfirmed.
    w.writeU8(0); // flag43F
    w.writeU8(0); // flag459
    w.writeU32(0); // val425
    w.writeU16(0); // val272
  }

  w.writeU8(0); // flag72
  w.writeU8(0); // flag73
  w.writeU8(0); // flag89
  w.writeU8(0); // flag368
  w.writeU16(0); // word512
  w.writeU8(0); // flag167

  // TW feature 9 (`sub_5CEA88(9) != 0`): `sub_5D9F00` (`sub_5CC5C1`)
  if (state.config.enabledFeatures.has(9)) {
    w.writeU32(0);
  }

  return w;
}

/**
 * Builds the Client's S->C 19 `CUserDynamicInfo` update.
 *
 * The Client reads one `u8` player count followed by a fixed-width record and a string for each
 * local player. `level` is source-mapped: the Client stores this `u16` through `sub_5ED30E` and
 * later reads it through `sub_5ED43B` for channel-level checks. The remaining fields are read by
 * `sub_5ED779`, but their meanings are not established in this reconstruction; they are emitted
 * as neutral zero/empty defaults rather than guessed from similarly named database columns.
 * The Client then sets its App-global readiness wrapper (`CUserDynamicInfo+380`) to logical 1.
 *
 * Client read order per record:
 * `u16 level, u8, u32, u8, u8, u32, u32, u8, u32, u8, u16, u8, u8, str, u8, u8`.
 * The Client narrows some `u16/u32` values while storing them; wire widths remain as read above.
 */
export function buildUserDynamicInfoSyncPacket(
  users: readonly Pick<UserRecord, "level">[]
): PacketWriter {
  if (users.length < 1 || users.length > 2) {
    throw new RangeError(`S->C 19 supports one or two local users, got ${users.length}`);
  }

  const packet = new PacketWriter(ServerOpcode.UserDynamicInfoSync);
  packet.writeU8(users.length);
  for (const user of users) {
    packet.writeU16(user.level);
    packet.writeU8(0); // Client ladder/profile byte; meaning UNKNOWN.
    packet.writeU32(0); // Client ladder/profile value; meaning UNKNOWN.
    packet.writeU8(0); // Client ladder/profile byte; meaning UNKNOWN.
    packet.writeU8(0); // Client normalizes zero to one in sub_58BF04; field meaning UNKNOWN.
    packet.writeU32(0); // Client clamps this field in sub_5ED522; meaning UNKNOWN.
    packet.writeU32(0); // Client stores this value and value/24 in sub_5ED327; meaning UNKNOWN.
    packet.writeU8(0); // Same sub_561F62 destination as the opaque LoginResult byte.
    packet.writeU32(0); // Client narrows this u32 to char in sub_5ED36F; meaning UNKNOWN.
    packet.writeU8(0); // Client applies a lookup/special case in sub_5ED3A3; meaning UNKNOWN.
    packet.writeU16(0); // Client narrows this u16 to char in sub_58A56C; meaning UNKNOWN.
    packet.writeU8(0); // Client profile byte; meaning UNKNOWN.
    packet.writeU8(0); // Client profile byte; meaning UNKNOWN.
    packet.writeString(""); // Client-owned string field; mapping UNKNOWN.
    packet.writeU8(0); // Client per-user trailing byte; meaning UNKNOWN.
    packet.writeU8(0); // Client per-user trailing byte; meaning UNKNOWN.
  }
  return packet;
}

/**
 * Handles Login requests (`C->S 2`, `C->S 11`, `C->S 31`).
 */
export function handleLogin(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  const credentials: { username: string; password: string }[] = [];

  if (opcode === ClientOpcode.LoginCredentials) {
    const playerCount = Math.min(2, Math.max(1, reader.readU8()));
    for (let i = 0; i < playerCount; i++) {
      const username =
        reader.readKeyedString(0x11223344).trim() || `player${session.sessionId}_${i + 1}`;
      const password = reader.readKeyedString(0x44332211);
      credentials.push({ username, password });
    }
  } else if (opcode === ClientOpcode.LoginPassport) {
    const passport = reader.readKeyedString(0xaabbccdd).trim() || `twuser${session.sessionId}`;
    credentials.push({ username: passport, password: "" });
  } else if (opcode === ClientOpcode.LoginBeanfunToken) {
    const _mode = reader.readU8();
    const tokenOrId = reader.readString().trim() || `twbean${session.sessionId}`;
    credentials.push({ username: tokenOrId, password: "" });
  } else {
    logger.warn("Login", "Refused to parse an unverified Client packet as credentials", {
      sessionId: session.sessionId,
      connectionKind: session.connectionKind,
      opcode: formatClientOpcode(opcode),
      stageId: formatStageId(session.stageId),
      payloadBytes: reader.remaining,
      databaseMutation: false,
      responseSent: false,
    });
    return;
  }

  logger.debug("Login", `Received ${formatClientOpcode(opcode)}`, {
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    remoteAddress: session.remoteAddress,
    remotePort: session.remotePort,
    usernames: credentials.map(({ username }) => username),
    playerCount: credentials.length,
  });

  session.users = [];
  session.netSlotIds = [];
  session.equippedCharIds = [];

  for (const cred of credentials) {
    const auth = state.db.authenticateOrCreate(cred.username, cred.password);
    if (auth.status !== "ok" || !auth.user) {
      logger.warn("Login", "Authentication failed", {
        sessionId: session.sessionId,
        username: cred.username,
        status: auth.status,
      });
      const errWriter = new PacketWriter(ServerOpcode.LoginResult);
      errWriter.writeU8(3); // 3 = wrong password / login error
      session.sendPacket(errWriter);
      return;
    }
    session.users.push(auth.user);
    session.netSlotIds.push(state.allocateNetSlotId());
    session.equippedCharIds.push(auth.user.equippedChar);
  }

  session.sendPacket(buildLoginSuccessPacket(state, session));
  // LoginStage forwards S->C 19 to the common CStage fallback. The Client parser initializes
  // the per-user dynamic-info records and sets its App-global readiness gate before channel selection.
  session.sendPacket(buildUserDynamicInfoSyncPacket(session.users));
  logger.info("Login", "Authentication succeeded", {
    sessionId: session.sessionId,
    playerCount: session.users.length,
  });
  logger.debug("Login", "Login identity and channel eligibility details", {
    sessionId: session.sessionId,
    users: session.users.map((user) => ({
      userId: user.id,
      username: user.username,
      loginResultGateLevel: user.level,
      channelLevelChecks: state.channels.map((channel) => ({
        name: channel.name,
        minLevel: channel.minLevel,
        maxLevel: channel.maxLevel,
        eligible: user.level >= channel.minLevel && user.level <= channel.maxLevel,
      })),
    })),
    netSlotIds: session.netSlotIds,
    playerCount: session.users.length,
  });
}

/**
 * Handles `C->S 9` (`CLoginStage` post-login `channel2_%03d%s.ssd` request or `CSelectServerStage` refresh):
 * Client sends:
 *   `u32 clientChannelCacheCrc` (`sub_5D3BFC` at `0x005D3BFC`)
 * Server replies:
 *   - `S->C 10` (`CStage::sub_4BDBF5` -> `sub_5D42CF` -> `sub_5D3E91` -> `sub_5D3D3F` `channel2_001.ssd` SmartStream)
 *   - `S->C 12` (`sub_5D4139` channel loads)
 *   - `S->C 11` (`CLoginStage::sub_567B0F` community/messenger handoff & `CWaitForLoginDlg` completion)
 */
export function handlePostLoginChannelRequest(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  const clientChannelCrc = reader.remaining >= 4 ? reader.readU32() : 0;
  logger.debug("ChannelCache", `Received ${formatClientOpcode(ClientOpcode.RequestChannelList)}`, {
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: session.stageId,
    clientChannelCrc: formatU32Hex(clientChannelCrc),
  });

  // The first C->S 9 is issued by CLoginStage after successful login. After the
  // SelectServer -> GameServer reconnect, CStage::sub_4B94A6 sends another C->S 9 while
  // already in Lobby; that packet is a cache notification, not a second login handoff.
  if (session.stageId !== StageId.Login) {
    logger.debug("ChannelCache", "Ignored post-login C->S 9 outside CLoginStage", {
      sessionId: session.sessionId,
      stageId: session.stageId,
      connectionKind: session.connectionKind,
    });
    return;
  }

  sendChannelListAndLoads(state, session);

  const packet11 = new PacketWriter(ServerOpcode.MessengerHandoff);
  packet11.writeString(state.config.publicIp);
  packet11.writeU16(state.config.messengerPort);
  packet11.writeU16(state.config.tcpPort);
  packet11.writeU16(state.config.udpPort);
  if (state.config.enabledFeatures.has(17)) {
    packet11.writeU8(0);
  }
  packet11.writeU16(0); // urlCount = 0
  packet11.writeU16(0); // trailingWord = 0
  session.sendPacket(packet11);

  session.stageId = StageId.SelectServer;
  logger.info("ChannelCache", "Login channel-list handoff completed", {
    sessionId: session.sessionId,
    nextStage: StageId.SelectServer,
    channels: state.channels.length,
    messengerIp: state.config.publicIp,
    messengerPort: state.config.messengerPort,
  });
}

function observeUnresolvedClientPacket(
  session: ClientSession,
  opcode: number,
  reader: PacketReader,
  explanation: string
): void {
  logger.info("PacketAudit", `Observed ${formatClientOpcode(opcode)}; ${explanation}`, {
    direction: "C->S",
    wireOpcode: opcode,
    opcodeName: formatClientOpcode(opcode),
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    payloadBytes: reader.remaining,
    responseAssociation: "UNKNOWN",
    responseSent: false,
    databaseMutation: false,
  });
}

/**
 * Unified Auth & Pre-Login handler for source-supported Login / pre-login paths.
 * ClientOpcode 16 is handled as stage-contextual chat outside pre-login; no current-build
 * ID-check writer or C->S 17 agreement writer is established here.
 */
export function handleAuthPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  switch (opcode) {
    case ClientOpcode.PreLoginSsdCheck:
      handlePreLoginSsdCheck(state, session, reader);
      break;
    case ClientOpcode.NewUserIdentifierCheck3:
      // The two recovered C->S 3 writers use different bodies ([str, u8 selector] and [str]).
      // Their Client response route is not established, so preserve the bytes and send no reply.
      logger.info("Registration", "Observed C->S 3 new-user identifier check; response association UNKNOWN", {
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes: reader.remaining,
        responseAssociation: "UNKNOWN",
        responseSent: false,
        databaseMutation: false,
      });
      break;
    case ClientOpcode.LoginCredentials:
    case ClientOpcode.LoginPassport:
    case ClientOpcode.LoginBeanfunToken:
      handleLogin(state, session, opcode, reader);
      break;
    case ClientOpcode.UnresolvedClientPacket4:
    case ClientOpcode.UnresolvedClientPacket34:
    case ClientOpcode.UnresolvedClientPacket35:
    case ClientOpcode.UnresolvedClientPacket36: {
      const explanations: Record<number, string> = {
        [ClientOpcode.UnresolvedClientPacket4]:
          "Client has distinct feature/state-dependent form writers; reply and backend mapping UNKNOWN",
        [ClientOpcode.UnresolvedClientPacket34]:
          "Client writers use [u8 mode, str]; reply association UNKNOWN",
        [ClientOpcode.UnresolvedClientPacket35]:
          "Client writer uses [5*str, u8, 2*str]; meaning, reply, and backend mapping UNKNOWN",
        [ClientOpcode.UnresolvedClientPacket36]:
          "Client writer uses two strings and one u8; reply and backend mapping UNKNOWN",
      };
      observeUnresolvedClientPacket(session, opcode, reader, explanations[opcode]!);
      break;
    }
    case ClientOpcode.EKeyVerify:
    case ClientOpcode.EKeyChallengeResponse:
    case ClientOpcode.ChangeAccountPassword: {
      const explanations: Record<number, string> = {
        [ClientOpcode.EKeyVerify]:
          "Client E-Key writer is present; no S->C success response or backend association is established",
        [ClientOpcode.EKeyChallengeResponse]:
          "Client E-Key challenge writer is present; no S->C response association is established",
        [ClientOpcode.ChangeAccountPassword]:
          "CNCPasswordDlg writes three strings; no password-update backend or S->C 34 association is established",
      };
      observeUnresolvedClientPacket(session, opcode, reader, explanations[opcode]!);
      break;
    }
  }
}
