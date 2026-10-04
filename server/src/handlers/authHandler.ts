import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import { formatClientOpcode, formatServerOpcode, formatU32Hex, logger } from "../utils/logger.ts";
import {
  buildMultiSvrNSmartStream,
  buildMultiSvrSmartStream,
  type SsdCacheEntry,
} from "../resources/archive.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { sendChannelListAndLoads } from "./channelHandler.ts";

function isKnownValidSsdChecksum(
  state: WorldState,
  ssd: SsdCacheEntry | undefined,
  clientCrc: number
): boolean {
  if (clientCrc === 0 || !ssd) {
    return true;
  }
  if (
    clientCrc === ssd.adler32Zero ||
    clientCrc === ssd.diskAdler32Zero ||
    clientCrc === ssd.crc32 ||
    clientCrc === ssd.rawCrc32 ||
    clientCrc === ssd.uncompressedCrc32
  ) {
    return true;
  }
  // Also accept any valid disk .ssd checksum when legacy callers pass 5-tuple in alternate order
  for (const entry of state.resources.ssdFiles.values()) {
    if (
      clientCrc === entry.adler32Zero ||
      clientCrc === entry.diskAdler32Zero ||
      clientCrc === entry.crc32
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
 * Handles Pre-login SSD Hash Verification (`C->S 0`, `CFxApp::sub_5A1E40` at `0x005A1E40`):
 * Client sends:
 *   1. `u32 crcFxdynimginfo` (`dword_92AAF8[2]` = `0x084341A5` on disk)
 *   2. `u32 crcCsysstr`      (`*(_DWORD *)(dword_929D68 + 88)` = `0xE734D04F` on disk)
 *   3. `u32 crcMultisvr`     (`*(_DWORD *)(dword_92D9EC + 108)`)
 *   4. `u32 crcFilterstr`    (`sub_5C8224(dword_974D94)` = `0x000E496D` on disk)
 *   5. (if `sub_5CDBF2(4) != 0`) `u32 crcMultisvrn` (`*(_DWORD *)(dword_92D9EC + 112)`)
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
  const crcFxdynimginfo = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcCsysstr = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcMultisvr = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcFilterstr = reader.remaining >= 4 ? reader.readU32() : 0;
  const crcMultisvrn = reader.remaining >= 4 ? reader.readU32() : 0;

  logger.info("AuthSync", `Received ${formatClientOpcode(ClientOpcode.PreLoginSsdCheck)}`, {
    sessionId: session.sessionId,
    remoteAddress: session.remoteAddress,
    remotePort: session.remotePort,
    checksums: {
      fxdynimginfo: formatU32Hex(crcFxdynimginfo),
      csysstr: formatU32Hex(crcCsysstr),
      multisvr: formatU32Hex(crcMultisvr),
      filterstr: formatU32Hex(crcFilterstr),
      multisvrn: formatU32Hex(crcMultisvrn),
    },
    unreadBytes: reader.remaining,
  });

  const sendSsdReply = (opcode: number, filename: string, clientCrc: number): void => {
    const ssd = state.resources.ssdFiles.get(filename);
    const hasMatchingChecksum = isKnownValidSsdChecksum(state, ssd, clientCrc);
    const hasStream = ssd !== undefined && !hasMatchingChecksum;
    const writer = new PacketWriter(opcode);
    writer.writeU8(hasStream ? 1 : 0);
    if (hasStream && ssd) {
      const stream = new SmartStreamWriter();
      stream.writeRaw(ssd.decompressed);
      writer.writeSmartStream(stream, true);
    }
    logger.info("AuthSync", `${formatServerOpcode(opcode)} ${filename} sync decision`, {
      sessionId: session.sessionId,
      clientChecksum: formatU32Hex(clientCrc),
      serverChecksum: ssd ? formatU32Hex(ssd.adler32Zero) : "missing",
      hasStream,
      uncompressedBytes: hasStream ? ssd?.decompressed.length : 0,
    });
    session.sendPacket(writer);
  };

  // 1. S->C 189: fxdynimginfo.ssd (`sub_49E093`)
  sendSsdReply(ServerOpcode.DynamicImgInfoSsd, "fxdynimginfo.ssd", crcFxdynimginfo);

  // 2. S->C 2: csysstr.ssd (`sub_5D00B9`)
  sendSsdReply(ServerOpcode.SystemStringSsd, "csysstr.ssd", crcCsysstr);

  // 3. S->C 1: multisvr.ssd / multisvrn.ssd (`sub_5D7E8E`)
  const multisvrEntry = state.resources.ssdFiles.get("multisvr.ssd");
  const multisvrnEntry = state.resources.ssdFiles.get("multisvrn.ssd");
  const multisvrChecksumKnown = isKnownValidSsdChecksum(state, multisvrEntry, crcMultisvr);
  // A custom, non-sentinel CRC means the client has a locally edited multisvr.ssd (usually
  // to point at the test server). Preserve it instead of replacing it with our generated list.
  const preserveClientMultisvr =
    !multisvrChecksumKnown && crcMultisvr > 0xffff && crcMultisvr !== 0xffffffff;
  const needMultiSvr = !multisvrChecksumKnown && !preserveClientMultisvr;
  const needMultiSvrN =
    crcMultisvrn !== 0 && !isKnownValidSsdChecksum(state, multisvrnEntry, crcMultisvrn);
  logger.info("AuthSync", "Prepared CMultiServer SSD response", {
    sessionId: session.sessionId,
    clientMultisvrCrc: formatU32Hex(crcMultisvr),
    knownServerChecksum: multisvrChecksumKnown,
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
 * Exact field layout verified at `0x00567400` and `0x00566E08`.
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
    session.equippedCharIds
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
    w.writeU8(user.level);
    w.writeU16(user.rankFlag);
    w.writeU8(user.equippedChar);
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
    const username = reader.remaining >= 2 ? reader.readString().trim() : `player${session.sessionId}`;
    credentials.push({ username: username || `player${session.sessionId}`, password: "" });
  }

  logger.info("Login", `Received ${formatClientOpcode(opcode)}`, {
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
  logger.info("Login", "Authentication succeeded", {
    sessionId: session.sessionId,
    users: session.users.map((user) => ({ userId: user.id, username: user.username })),
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
  logger.info("ChannelCache", `Received ${formatClientOpcode(ClientOpcode.RequestChannelList)}`, {
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

/**
 * Handles `C->S 16` (Verify account ID availability), `C->S 17` (Agreement accept), and `C->S 18` (Register new account).
 */
export function handleVerifyOrRegister(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  if (opcode === ClientOpcode.CheckIdOrNormalChat) {
    const username = reader.remaining >= 2 ? reader.readString().trim() : "";
    const existing = username ? state.db.getUserByUsername(username) : null;
    const w = new PacketWriter(ServerOpcode.CheckIdResult);
    w.writeU8(existing ? 1 : 0);
    session.sendPacket(w);
  } else if (opcode === ClientOpcode.AcceptAgreement) {
    const w9 = new PacketWriter(ServerOpcode.StageTransition);
    w9.writeU32(StageId.OnePageId);
    session.sendPacket(w9);
  } else if (opcode === ClientOpcode.RegisterAccount) {
    const username = reader.remaining >= 2 ? reader.readString().trim() : `user_${Date.now()}`;
    const password = reader.remaining >= 2 ? reader.readString() : "1234";
    state.db.authenticateOrCreate(username, password);
    const w = new PacketWriter(ServerOpcode.RegisterAccountResult);
    w.writeU8(0); // 0 = registration success
    session.sendPacket(w);
  }
}

/**
 * Unified Auth & Pre-Login handler (`CLoginStage`, `COnePageIDStage`, `CAgreementStage`, `CFxApp`).
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
    case ClientOpcode.LoginCredentials:
    case ClientOpcode.LoginPassport:
    case ClientOpcode.LoginVariant29:
    case ClientOpcode.LoginVariant30:
    case ClientOpcode.LoginBeanfunToken:
    case ClientOpcode.LoginVariant49:
      handleLogin(state, session, opcode, reader);
      break;
    case ClientOpcode.CheckIdOrNormalChat:
    case ClientOpcode.AcceptAgreement:
    case ClientOpcode.RegisterAccount:
      handleVerifyOrRegister(state, session, opcode, reader);
      break;
    case ClientOpcode.CreateOrUpdateAccount:
    case ClientOpcode.SubmitRegistrationForm:
    case ClientOpcode.VerifyAccountIdentity: {
      // C->S 4 (`sub_496D15`/`sub_4985CD`), C->S 35 (`sub_49AB07`), C->S 36 (`sub_49B6E4`) -> S->C 61 & S->C 34
      const username = reader.remaining >= 2 ? reader.readString().trim() : "";
      const password = reader.remaining >= 2 ? reader.readString() : "1234";
      if (username) {
        state.db.authenticateOrCreate(username, password);
      }
      const w61 = new PacketWriter(ServerOpcode.RegisterAccountResult);
      w61.writeU8(0);
      session.sendPacket(w61);

      const w34 = new PacketWriter(ServerOpcode.GuildOrUserStatus);
      w34.writeU8(0); // 0 = success (`sub_46BBB1`)
      session.sendPacket(w34);
      break;
    }
    case ClientOpcode.CheckUserIdAvailable: {
      // C->S 34 (`sub_49A5CA` / `sub_49A7F4`) -> S->C 59 (`CheckIdResult`) & S->C 34 (`sub_46BBB1`)
      const _mode = reader.remaining >= 1 ? reader.readU8() : 0;
      const username = reader.remaining >= 2 ? reader.readString().trim() : "";
      const existing = username ? state.db.getUserByUsername(username) : null;
      const w59 = new PacketWriter(ServerOpcode.CheckIdResult);
      w59.writeU8(existing ? 1 : 0);
      session.sendPacket(w59);

      const w34 = new PacketWriter(ServerOpcode.GuildOrUserStatus);
      w34.writeU8(existing ? 1 : 0);
      session.sendPacket(w34);
      break;
    }
    case ClientOpcode.EKeyVerify:
    case ClientOpcode.EKeyChallengeResponse:
    case ClientOpcode.ChangeAccountPassword: {
      // C->S 32 (`sub_55FB0B`), C->S 33 (`sub_561394`), C->S 46 (`sub_495C32`) -> S->C 34 (`sub_46BBB1`)
      const w34 = new PacketWriter(ServerOpcode.GuildOrUserStatus);
      w34.writeU8(0); // 0 = success (`sub_46BBB1`)
      session.sendPacket(w34);
      break;
    }
    case ClientOpcode.CheckPackageMapLegacy: {
      const w157 = new PacketWriter(ServerOpcode.PackageMapCheckAck);
      w157.writeU8(0);
      session.sendPacket(w157);
      break;
    }
    case ClientOpcode.CheckNoticeUrl: {
      const w163 = new PacketWriter(ServerOpcode.NoticeUrlSync);
      w163.writeString(state.config.noticeUrl);
      session.sendPacket(w163);
      break;
    }
    case ClientOpcode.CheckStringTableLegacy: {
      const w179 = new PacketWriter(ServerOpcode.StringTableCheckAck);
      w179.writeU8(0);
      session.sendPacket(w179);
      break;
    }
    case ClientOpcode.CheckFxStockLegacy: {
      const w188 = new PacketWriter(ServerOpcode.FxStockCheckAck);
      w188.writeU8(0);
      session.sendPacket(w188);
      break;
    }
  }
}
