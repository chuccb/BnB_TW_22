import type { UserRecord } from "../db/database.ts";
import { ClientOpcode, ServerOpcode } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { logger } from "../utils/logger.ts";

/**
 * Writes a single `CRankMan` rank entry matching `sub_4A4FBD` (`0x004A4FBD`):
 *   str username (`sub_698270`)
 *   u8 gender (`sub_6974B0`)
 *   u8 charId (`sub_6974B0`)
 *   u32 rank (`sub_697580`)
 *   u16 level (`sub_697510`)
 *   u32 exp (`sub_697580`)
 *   u32 wins (`sub_697580`)
 *   u32 losses (`sub_697580`)
 *   u32 draws (`sub_697580`)
 *   u8 status (`sub_6974B0`)
 *   u16 a1 (`sub_697510`)
 *   u16 a2 (`sub_697510`)
 *   u16 a3 (`sub_697510`)
 *   u16 a4 (`sub_697510`)
 */
export function writeRankEntry4A4FBD(
  w: PacketWriter,
  user: UserRecord,
  rank: number = 1,
  charId: number = 0
): void {
  w.writeString(user.username);
  w.writeU8(user.gender);
  w.writeU8(charId & 0xff);
  w.writeU32(rank);
  w.writeU16(user.level);
  w.writeU32(user.exp);
  w.writeU32(user.wins);
  w.writeU32(user.losses);
  w.writeU32(user.draws);
  w.writeU8(1); // status
  w.writeU16(0);
  w.writeU16(0);
  w.writeU16(0);
  w.writeU16(0);
}

/**
 * Builds S->C 69 (`sub_4A5114` at `0x004A5114`) or S->C 66 (`sub_4A51B5` at `0x004A51B5`):
 *   u16 startRank
 *   u8 count (<= 10)
 *   count * `writeRankEntry4A4FBD`
 */
export function buildRankingListPacket69(
  state: WorldState,
  session: ClientSession,
  startRank: number = 1,
  opcode: number = ServerOpcode.RankingList
): PacketWriter {
  const users: UserRecord[] = [];
  for (const s of state.sessions.values()) {
    for (const u of s.users) {
      if (!users.some((x) => x.id === u.id)) {
        users.push(u);
      }
    }
  }
  if (users.length === 0 && session.users[0]) {
    users.push(session.users[0]);
  }
  const page = users.slice(0, 10);
  const w = new PacketWriter(opcode);
  w.writeU16(Math.max(1, startRank));
  w.writeU8(page.length);
  for (let i = 0; i < page.length; i++) {
    writeRankEntry4A4FBD(w, page[i]!, startRank + i, 0);
  }
  return w;
}

/**
 * Builds S->C 240 (`sub_4A522B` at `0x004A522B`) Top-3 Ranking packet:
 *   u8 count (<= 3)
 *   count * `writeRankEntry4A4FBD`
 */
export function buildRankingTop3Packet240(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const users: UserRecord[] = [];
  for (const s of state.sessions.values()) {
    for (const u of s.users) {
      if (!users.some((x) => x.id === u.id)) {
        users.push(u);
      }
    }
  }
  if (users.length === 0 && session.users[0]) {
    users.push(session.users[0]);
  }
  const top3 = users.slice(0, 3);
  const w240 = new PacketWriter(ServerOpcode.RankingTop3);
  w240.writeU8(top3.length);
  for (let i = 0; i < top3.length; i++) {
    writeRankEntry4A4FBD(w240, top3[i]!, i + 1, 0);
  }
  return w240;
}

/**
 * Builds S->C 256 (`sub_4B96F3` -> `sub_4A527F` at `0x004A527F`) My Character Rank packet:
 *   For each local player (`0..playerCount-1`):
 *     u8 hasRank (`1`)
 *     `writeRankEntry4A4FBD`
 *     u32 rankDelta (`0`)
 *     u8 tier (`1`)
 */
export function buildMyCharacterRankPacket256(session: ClientSession): PacketWriter {
  const players = session.users.length > 0 ? session.users : [null];
  const w256 = new PacketWriter(ServerOpcode.MyCharacterRank);
  for (let i = 0; i < players.length; i++) {
    const u = players[i];
    if (!u) {
      w256.writeU8(0);
    } else {
      w256.writeU8(1);
      writeRankEntry4A4FBD(w256, u, i + 1, 0);
      w256.writeU32(0); // rankDelta
      w256.writeU8(1); // tier
    }
  }
  return w256;
}

/**
 * Builds S->C 71 (`sub_5403BB` at `0x005403BB` / `sub_54D47F` at `0x0054D47F`) User Stats / Profile Detail:
 *   u8 found (`1`)
 *   str username
 *   u8 gender
 *   u32 rankOrLevel
 *   str guildOrLocation
 *   u16 ageOrYear
 *   str memoOrIntro
 */
export function buildUserStatsPacket71(targetUser: UserRecord | null): PacketWriter {
  const w71 = new PacketWriter(ServerOpcode.UserStats71);
  if (!targetUser) {
    w71.writeU8(0);
    return w71;
  }
  w71.writeU8(1);
  w71.writeString(targetUser.username);
  w71.writeU8(targetUser.gender);
  w71.writeU32(targetUser.level);
  w71.writeString(targetUser.guildName || "BnB Taiwan");
  w71.writeU16(20);
  w71.writeString(`Lv.${targetUser.level} (${targetUser.wins}W/${targetUser.losses}L)`);
  return w71;
}

/**
 * Builds S->C 248 (`CStage::sub_4B9DB6` -> `sub_5C649C` at `0x005C649C`) User Quest & Slot Info:
 *   u8 playerIdx
 *   u32 questMask
 *   i32 count (`0`)
 *   count * 28B block
 */
export function buildUserQuestInfoPacket248(playerIdx: number = 0): PacketWriter {
  const w248 = new PacketWriter(ServerOpcode.UserQuestAndSlotInfo248);
  w248.writeU8(playerIdx & 0xff);
  w248.writeU32(0);
  w248.writeI32(0);
  return w248;
}

/**
 * Builds S->C 81 (`CStage::sub_4BCDFF` at `0x004BCDFF`) User Profile Info packet.
 */
export function buildUserProfilePacket81(
  state: WorldState,
  targetUser: UserRecord | null
): PacketWriter {
  const w81 = new PacketWriter(ServerOpcode.QuickJoinOrUserProfile);
  if (!targetUser) {
    w81.writeString("");
    return w81;
  }
  const stock = state.db.getUserStock(targetUser.id).filter((s) => s.equipped !== 0);
  w81.writeString(targetUser.username);
  w81.writeU32(targetUser.level);
  w81.writeU32(targetUser.exp);
  w81.writeU32(targetUser.wins);
  w81.writeU32(targetUser.draws);
  w81.writeU32(targetUser.losses);
  w81.writeU32(1); // rank
  w81.writeU8(targetUser.gender);
  w81.writeString(targetUser.guildName);
  w81.writeU8(targetUser.guildMark);
  w81.writeU8(0); // localIdx
  w81.writeU16(stock.length);
  for (const item of stock) {
    w81.writeU32(item.itemCode);
  }
  w81.writeString("");
  return w81;
}

/**
 * Builds S->C 70 (`CStage` User Profile / Info Modal result).
 */
export function buildUserInfoResultPacket(
  state: WorldState,
  targetUser: UserRecord | null,
  responseOpcode: number = ServerOpcode.UserInfoModal70
): PacketWriter {
  const w = new PacketWriter(responseOpcode);
  if (!targetUser) {
    w.writeU32(0);
    return w;
  }

  const stock = state.db.getUserStock(targetUser.id).filter((s) => s.equipped !== 0);

  w.writeU32(1); // found = 1
  w.writeU32(targetUser.id);
  w.writeU8(0); // localIdx = 0
  w.writeString(targetUser.username);
  w.writeU32(targetUser.level);
  w.writeU32(targetUser.exp);
  w.writeU32(targetUser.lucci);
  w.writeU32(targetUser.wins);
  w.writeU32(targetUser.draws);
  w.writeU32(targetUser.losses);
  w.writeU32(targetUser.ladderPoints ?? 0);
  w.writeU8(targetUser.gender);
  w.writeString(targetUser.guildName);
  w.writeU8(targetUser.guildMark);
  w.writeU16(stock.length);
  for (const item of stock) {
    w.writeU32(item.itemCode);
  }
  return w;
}

/**
 * Builds S->C 207 (`CStage::sub_4BDBF5` case `207` -> `sub_4BCABF` at `0x004BCABF`):
 *   u8 flag (`*(_BYTE *)(dword_929D6C + 92)`)
 *   u32 fxdynmapinfoChecksum (`sub_4E0207(i_4, v2)` -> if mismatch, client sends `C->S 282`)
 *   u8 macroDetectorFlag (`sub_6F6810`)
 *   u16 val9757A0
 *   u32 val9757A4
 *   u8 extraCount
 *   extraCount * u8
 */
export function buildDynamicMapConfigPacket207(
  state: WorldState,
  flag: number = 0
): PacketWriter {
  const w207 = new PacketWriter(ServerOpcode.DynamicMapAndStageConfig);
  w207.writeU8(flag & 0xff);
  w207.writeU32(state.resources.ssdFiles.fxdynmapinfo.adler32Zero);
  w207.writeU8(0); // macroDetectorFlag
  w207.writeU16(0); // dword_9757A0
  w207.writeU32(0); // dword_9757A4
  w207.writeU8(0); // extraCount = 0
  return w207;
}

/**
 * Builds S->C 205 (`CStage::sub_4BDBF5` case `205` -> `sub_4E0131` at `0x004E0131`
 * -> `sub_4DFE20` at `0x004DFE20`):
 *   `[CISmartStream fxdynmapinfo.ssd]`
 */
export function buildDynamicMapStreamPacket205(state: WorldState): PacketWriter {
  const w205 = new PacketWriter(ServerOpcode.DynamicMapInfoSsdStream);
  const ss = new SmartStreamWriter();
  ss.writeRaw(state.resources.ssdFiles.fxdynmapinfo.decompressed);
  w205.writeSmartStream(ss, true);
  return w205;
}

/**
 * Builds S->C 250 (`CCouple::sub_5BBF91` at `0x005BBF91`):
 *   u8 playerCount
 *   For each local player:
 *     u8 coupleState (0 = single, 1 = coupled)
 *     if coupleState != 0:
 *       u8 coupleGrade (1..6)
 *       str partnerName
 *     if feature 30 enabled (`sub_5CEA88(30) != 0`):
 *       u16 anniversaryDays (0 = none)
 */
export function buildCoupleInfoSyncPacket250(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const players = session.users.length > 0 ? session.users : [null];
  const w250 = new PacketWriter(ServerOpcode.CoupleInfoSync);
  w250.writeU8(players.length);

  for (const user of players) {
    const couple = user ? state.db.getCoupleInfo(user.id) : null;
    if (!couple) {
      w250.writeU8(0);
    } else {
      w250.writeU8(1);
      w250.writeU8(Math.min(6, Math.max(1, couple.coupleGrade)));
      w250.writeString(couple.partnerName);
    }
    if (state.config.enabledFeatures.has(30)) {
      w250.writeU16(0); // anniversaryDays = 0
    }
  }
  return w250;
}

/**
 * Builds S->C 243 (`CSmsDlg::sub_484465` at `0x00484465`):
 *   u8 status (15)
 *   u8 count
 *   For each message:
 *     u32 msgId
 *     str senderName
 *     str messageText
 *     u16 month
 *     u16 day
 *     u16 hour
 *     u16 minute
 *     u8 isRead
 */
export function buildSmsListPacket243(
  state: WorldState,
  user: UserRecord | null
): PacketWriter {
  const msgs = user ? state.db.getSmsByUser(user.id).slice(0, 20) : [];
  const w243 = new PacketWriter(ServerOpcode.SmsList);
  w243.writeU8(15); // status == 15 (`sub_484465`)
  w243.writeU8(msgs.length);

  for (const m of msgs) {
    const dt = new Date(m.createdAt || Date.now());
    w243.writeU32(m.id);
    w243.writeString(m.senderName);
    w243.writeString(m.message);
    w243.writeU16(dt.getUTCMonth() + 1);
    w243.writeU16(dt.getUTCDate());
    w243.writeU16(dt.getUTCHours());
    w243.writeU16(dt.getUTCMinutes());
    w243.writeU8(m.isRead ? 1 : 0);
  }
  return w243;
}

/**
 * Broadcasts normal chat message (`S->C 21` `CChatStage::sub_4B070C` / `CGameStage::sub_4F4D49`
 * and `S->C 15`) to the session's current room or lobby channel.
 */
function broadcastNormalChat(
  state: WorldState,
  session: ClientSession,
  senderName: string,
  msg: string,
  chatType = 0
): void {
  const formatted = `${senderName} : ${msg}`;
  if (session.currentRoomNumber !== null) {
    const room = state.rooms.get(session.currentRoomNumber);
    if (room) {
      state.broadcastToRoom(room, () => {
        const w21 = new PacketWriter(ServerOpcode.NormalChat);
        w21.writeString(formatted);
        w21.writeU8(0); // normal color flag
        return w21;
      });
      state.broadcastToRoom(room, () => {
        const w15 = new PacketWriter(ServerOpcode.ChatBroadcast15);
        w15.writeU8(chatType);
        w15.writeU8(session.roomSlotIndices[0] ?? 0);
        w15.writeString(senderName);
        w15.writeString(msg);
        return w15;
      });
      return;
    }
  }

  state.broadcastToLobby(session.channelIndex, () => {
    const w21 = new PacketWriter(ServerOpcode.NormalChat);
    w21.writeString(formatted);
    w21.writeU8(0);
    return w21;
  });
  state.broadcastToLobby(session.channelIndex, () => {
    const w15 = new PacketWriter(ServerOpcode.ChatBroadcast15);
    w15.writeU8(chatType);
    w15.writeU8(0);
    w15.writeString(senderName);
    w15.writeString(msg);
    return w15;
  });
}

/**
 * Sends a whisper (`S->C 23` `CChatStage::sub_4A8727` / `CGameStage::sub_4F4F4B` to target,
 * and `S->C 24` `CChatStage::sub_4AE106` delivery status to sender).
 */
function sendWhisperChat(
  state: WorldState,
  session: ClientSession,
  senderName: string,
  targetName: string,
  msg: string
): void {
  const targetSession = state.findSessionByUsername(targetName);
  const formatted = `${senderName} : ${msg}`;

  if (targetSession) {
    const w23 = new PacketWriter(ServerOpcode.WhisperOrEmotion);
    w23.writeString(formatted);
    targetSession.sendPacket(w23);

    const w24 = new PacketWriter(ServerOpcode.WhisperDeliveryStatus);
    w24.writeU8(1); // delivered
    session.sendPacket(w24);
  } else {
    const w24 = new PacketWriter(ServerOpcode.WhisperDeliveryStatus);
    w24.writeU8(0); // NotInSameChannel
    w24.writeString(targetName);
    session.sendPacket(w24);
  }

  const makeW15 = () => {
    const w15 = new PacketWriter(ServerOpcode.ChatBroadcast15);
    w15.writeU8(2); // whisper
    w15.writeU8(0);
    w15.writeString(senderName);
    w15.writeString(msg);
    w15.writeString(targetName);
    return w15;
  };
  session.sendPacket(makeW15());
  if (targetSession && targetSession.sessionId !== session.sessionId) {
    targetSession.sendPacket(makeW15());
  }
}

/**
 * Handles cross-stage packets (`CPacketDispatcher`, `CStage`, `CChatStage`, `CRankMan`, `CMyInfoDlg`, `CCouple`, `CSmsDlg`).
 */
export function handleCommonPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  switch (opcode) {
    case ClientOpcode.UploadCrashDump: {
      // `CStage::sub_4B8D42` -> `sub_5D06FA` sends flag=1 chunks from Crash_CA.dmp:
      // `[u8 flag, u32 byteCount, block(byteCount)]`. `sub_5D137C` uses flag=0 without a block.
      if (reader.remaining < 5) {
        logger.warn("CrashDump", "Rejected C->S 8 packet with a truncated upload header", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: session.stageId,
          headerBytes: reader.remaining,
        });
        return;
      }

      const transferFlag = reader.readU8();
      const declaredByteCount = reader.readU32();
      const payloadByteCount = reader.remaining;
      const payloadLengthMatches =
        transferFlag === 0
          ? payloadByteCount === 0
          : transferFlag === 1 && payloadByteCount === declaredByteCount;
      const uploadForm =
        transferFlag === 0 ? "metadata" : transferFlag === 1 ? "chunk" : "unknown";
      const details = {
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: session.stageId,
        transferFlag,
        uploadForm,
        declaredByteCount,
        payloadByteCount,
        payloadLengthMatches,
      };

      if (payloadLengthMatches) {
        logger.info("CrashDump", "Received C->S 8 Crash_CA.dmp upload packet", details);
      } else {
        logger.warn(
          "CrashDump",
          "Received malformed C->S 8 Crash_CA.dmp upload packet",
          details
        );
      }

      // Crash dumps are not retained by this reconstruction. Consume the opaque block without
      // copying or logging its contents so later diagnostics only expose safe packet metadata.
      reader.offset = reader.plain.length;
      break;
    }

    case ClientOpcode.UploadCrashReport:
    case ClientOpcode.ClientReportOrLobbyEnter:
    case ClientOpcode.UpdateUserOptions:
    case ClientOpcode.SaveDefaultChars:
    case ClientOpcode.UpdatePremiumSlotState:
    case ClientOpcode.MyPageUpdateBadge:
    case ClientOpcode.RoomChiefBroadcast:
    case ClientOpcode.ReportPlayer:
    case ClientOpcode.CancelAction:
    case ClientOpcode.LobbyInitQuery:
    case ClientOpcode.MyPagePreOpen:
    case ClientOpcode.SecurityHashReply1:
    case ClientOpcode.SecurityHashReply2:
    case ClientOpcode.ClientAuditLog: {
      break;
    }

    case ClientOpcode.RequestDynI16Table:
    case ClientOpcode.RequestAvatarI16Table: {
      // C->S 27 (`sub_59A700`) / C->S 28 (`sub_59B5A2`): `[u32 id, u16 version]`
      // Replies with S->C 32 (`CStage::sub_4B8D5F` -> `sub_59D0D4`): `[u32 id, u16 version(0), u32 size(0)]`
      const id = reader.remaining >= 4 ? reader.readU32() : 0;
      const w32 = new PacketWriter(ServerOpcode.DynamicI16Data);
      w32.writeU32(id);
      w32.writeU16(0);
      w32.writeU32(0);
      session.sendPacket(w32);
      break;
    }

    case ClientOpcode.MessengerInviteUser: {
      // C->S 21 (`sub_4B4F83` / `sub_4DB16C` / `sub_55AAF0` / `sub_5E9F86`): `[u16 roomNum, u32 key, str targetUser, u8 flag]`
      const _roomNum = reader.remaining >= 2 ? reader.readU16() : 0;
      const _roomKey = reader.remaining >= 4 ? reader.readU32() : 0;
      const targetUser = reader.remaining >= 2 ? reader.readString() : "";
      const senderName = session.users[0]?.username ?? `Player${session.sessionId}`;
      if (targetUser) {
        sendWhisperChat(state, session, senderName, targetUser, `[Invite to Room #${_roomNum}]`);
      }
      break;
    }

    case ClientOpcode.MacroListQuery: {
      // C->S 40 (`sub_4A29A1`) -> S->C 50 (`sub_4A27CB`)
      const w50 = new PacketWriter(ServerOpcode.MacroList);
      session.sendPacket(w50);
      break;
    }

    case ClientOpcode.QuestAction: {
      // C->S 44 (`CQuestWnd::sub_551AE2`) -> S->C 248 (`sub_4B9DB6`)
      session.sendPacket(buildUserQuestInfoPacket248(0));
      break;
    }

    case ClientOpcode.QueryRankingPage: {
      // C->S 64 (`sub_4A48F2`: `[u16 startRank]`) -> S->C 69 (`sub_4A5114`)
      const startRank = reader.remaining >= 2 ? reader.readU16() : 1;
      session.sendPacket(buildRankingListPacket69(state, session, startRank, ServerOpcode.RankingList));
      break;
    }

    case ClientOpcode.QueryTop3Rank: {
      // C->S 296 (`sub_4A49D8`) -> S->C 240 (`sub_4A522B`)
      session.sendPacket(buildRankingTop3Packet240(state, session));
      break;
    }

    case ClientOpcode.QueryMyCharacterRank: {
      // C->S 311 (`sub_4A4A0F`) -> S->C 256 (`sub_4B96F3` -> `sub_4A527F`)
      session.sendPacket(buildMyCharacterRankPacket256(session));
      break;
    }

    case ClientOpcode.UseSuperSpeaker: {
      // C->S 72 (`sub_4A3E36`: `[u8 localIdx, u8 speakerType, str message]`)
      const localIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const _speakerType = reader.remaining >= 1 ? reader.readU8() : 0;
      const msg = reader.remaining >= 2 ? reader.readString() : "";
      const senderName = session.users[localIdx]?.username ?? session.users[0]?.username ?? `Player${session.sessionId}`;
      broadcastNormalChat(state, session, senderName, msg, 0);
      break;
    }

    case ClientOpcode.PingReplyOrWhisper: {
      if (reader.remaining >= 4) {
        const savedOffset = reader.offset;
        const firstLen = reader.readU16();
        if (firstLen > 0 && firstLen <= 32 && reader.remaining >= firstLen + 2) {
          reader.offset += firstLen;
          const secondLen = reader.readU16();
          if (secondLen === reader.remaining) {
            reader.offset = savedOffset;
            const targetName = reader.readString();
            const msg = reader.readString();
            const senderName = session.users[0]?.username ?? `Player${session.sessionId}`;
            sendWhisperChat(state, session, senderName, targetName, msg);
            break;
          }
        }
        reader.offset = savedOffset;
      }

      if (reader.remaining >= 4) {
        session.lastPingTick = reader.readU32();
      }
      break;
    }

    case ClientOpcode.RequestDynamicMapInfoSsd: {
      // C->S 282 (`sub_4DD5D3`) -> S->C 205 (`sub_4E0131` -> `sub_4DFE20`)
      session.sendPacket(buildDynamicMapStreamPacket205(state));
      break;
    }

    case ClientOpcode.PostStageSync338: {
      // C->S 338 (`sub_4B94A6`) -> S->C 207 (`sub_4BCABF`)
      const flag = reader.remaining >= 1 ? reader.readU8() : 0;
      session.sendPacket(buildDynamicMapConfigPacket207(state, flag));
      break;
    }

    case ClientOpcode.CheckIdOrNormalChat: {
      const msg = reader.remaining >= 2 ? reader.readString() : "";
      const senderName = session.users[0]?.username ?? `Player${session.sessionId}`;
      broadcastNormalChat(state, session, senderName, msg, 0);
      break;
    }

    case ClientOpcode.TeamChat: {
      const msg = reader.remaining >= 2 ? reader.readString() : "";
      const senderName = session.users[0]?.username ?? `Player${session.sessionId}`;
      const senderSlot = session.roomSlotIndices[0] ?? 0;

      if (session.currentRoomNumber !== null) {
        const room = state.rooms.get(session.currentRoomNumber);
        if (room) {
          const senderTeam = room.slots[senderSlot]?.teamColor ?? 0;
          const sentSessions = new Set<number>();
          for (const s of room.slots) {
            if (s.occupied && s.session) {
              if (
                senderTeam === 0 ||
                s.teamColor === senderTeam ||
                s.session.sessionId === session.sessionId
              ) {
                if (!sentSessions.has(s.session.sessionId)) {
                  sentSessions.add(s.session.sessionId);
                  const w114 = new PacketWriter(ServerOpcode.TeamChatBroadcast);
                  w114.writeU8(senderSlot);
                  w114.writeString(msg);
                  s.session.sendPacket(w114);
                }
              }
            }
          }
          break;
        }
      }
      broadcastNormalChat(state, session, senderName, msg, 1);
      break;
    }

    case ClientOpcode.ReturnToChannelSelect:
    case ClientOpcode.AdminNoticeChat:
    case ClientOpcode.ChatMessageWithType: {
      let chatType = 0;
      if (reader.remaining >= 3) {
        const saved = reader.offset;
        const candidateType = reader.readU8();
        const nextLen = reader.readU16();
        reader.offset = saved;
        if (nextLen === reader.remaining - 3 || candidateType <= 4) {
          chatType = reader.readU8();
        }
      }
      const msg = reader.remaining >= 2 ? reader.readString() : "";
      const targetName = reader.remaining >= 2 ? reader.readString() : "";
      const senderName = session.users[0]?.username ?? `Player${session.sessionId}`;

      if (chatType === 2 && targetName) {
        sendWhisperChat(state, session, senderName, targetName, msg);
      } else {
        broadcastNormalChat(state, session, senderName, msg, chatType);
      }
      break;
    }

    case ClientOpcode.RoomEmotion:
    case ClientOpcode.EquipQuickSlotOrEmotion: {
      const slotIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const emoId =
        reader.remaining >= 2
          ? reader.readU16()
          : reader.remaining >= 1
            ? reader.readU8()
            : 0;
      if (session.currentRoomNumber !== null) {
        const room = state.rooms.get(session.currentRoomNumber);
        if (room) {
          state.broadcastToRoom(room, () => {
            const w23 = new PacketWriter(ServerOpcode.WhisperOrEmotion);
            w23.writeU8(slotIdx);
            w23.writeU16(emoId);
            return w23;
          });
        }
      }
      break;
    }

    case ClientOpcode.QueryUserBrief: {
      // C->S 69 (`sub_4A0321`: `[u32 userId]`) -> S->C 70
      const targetId = reader.remaining >= 4 ? reader.readU32() : 0;
      let targetUser: UserRecord | null = null;
      for (const s of state.sessions.values()) {
        for (const u of s.users) {
          if (u.id === targetId) {
            targetUser = u;
            break;
          }
        }
      }
      session.sendPacket(
        buildUserInfoResultPacket(state, targetUser ?? session.users[0] ?? null, ServerOpcode.UserInfoModal70)
      );
      break;
    }

    case ClientOpcode.QueryUserInfo66:
    case ClientOpcode.RoomDetailOrUserInfo:
    case ClientOpcode.QueryUserInfo:
    case ClientOpcode.UserDetailQuery: {
      if (opcode === ClientOpcode.QueryUserInfo && reader.remaining >= 3) {
        const saved = reader.offset;
        const subOp = reader.readU8();
        const strLen = reader.readU16();
        if (subOp <= 4 && strLen === reader.remaining) {
          reader.offset = saved + 1;
        } else {
          reader.offset = saved;
        }
      }
      const targetUsername = reader.remaining >= 2 ? reader.readString().trim() : "";
      const targetUser =
        (targetUsername ? state.db.getUserByUsername(targetUsername) : null) ??
        session.users[0] ??
        null;
      session.sendPacket(buildUserInfoResultPacket(state, targetUser, ServerOpcode.UserInfoModal70));
      session.sendPacket(buildUserProfilePacket81(state, targetUser));
      if (opcode === ClientOpcode.QueryUserInfo66) {
        session.sendPacket(buildUserStatsPacket71(targetUser));
        session.sendPacket(buildUserQuestInfoPacket248(0));
      }
      break;
    }

    case ClientOpcode.ModifyUserInfo:
    case ClientOpcode.UserGuildModify: {
      // C->S 65 / C->S 292 (`sub_5495CD`): `[u8 playerIdx, str guildOrName, ...]`
      const playerIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const guildOrName = reader.remaining >= 2 ? reader.readString() : "";
      const user = session.users[playerIdx] ?? session.users[0];
      if (user && opcode === ClientOpcode.UserGuildModify) {
        user.guildName = guildOrName;
        state.db.updateUserGuild(user.id, guildOrName, user.guildMark);
      }
      break;
    }

    case ClientOpcode.QueryGuildInfo: {
      // C->S 68 (`sub_53DEEA`) -> S->C 34 (`sub_54466F`)
      const targetName = reader.remaining >= 2 ? reader.readString() : "";
      const targetUser =
        (targetName ? state.db.getUserByUsername(targetName) : null) ?? session.users[0];
      const w34 = new PacketWriter(ServerOpcode.GuildOrUserStatus);
      w34.writeU8(1);
      w34.writeString(targetUser?.guildName ?? "");
      session.sendPacket(w34);
      break;
    }

    case ClientOpcode.CouplePartnerCheck: {
      // C->S 290 (`sub_53DEEA`: `[str partnerName]`) -> S->C 242 (`sub_544049` -> `sub_49D0A6`)
      const partnerName = reader.remaining >= 2 ? reader.readString() : "";
      const partner = partnerName ? state.db.getUserByUsername(partnerName) : null;
      const w242 = new PacketWriter(ServerOpcode.SmsSendResult);
      w242.writeU8(partner ? 1 : 0);
      w242.writeString(partner?.username ?? partnerName);
      session.sendPacket(w242);
      break;
    }

    case ClientOpcode.UserPairStatsQuery: {
      // C->S 293 (`sub_53DEEA`: `[str userA, str userB]`) -> S->C 220 (`sub_54466F`)
      const _userA = reader.remaining >= 2 ? reader.readString() : "";
      const _userB = reader.remaining >= 2 ? reader.readString() : "";
      const w220 = new PacketWriter(ServerOpcode.PairStatsResult);
      w220.writeU32(0); // wins together
      w220.writeU32(0); // losses together
      w220.writeU32(0); // draws together
      session.sendPacket(w220);
      break;
    }

    case ClientOpcode.SmsSend: {
      // C->S 297 (`CSmsDlg::sub_4810F3`: `[str senderName, str receiverName, str message]`) -> S->C 242 (`sub_4838E8`)
      const senderName =
        reader.remaining >= 2
          ? reader.readString()
          : (session.users[0]?.username ?? `Player${session.sessionId}`);
      const receiverName = reader.remaining >= 2 ? reader.readString() : "";
      const message = reader.remaining >= 2 ? reader.readString() : "";

      if (senderName.toLowerCase() === receiverName.toLowerCase()) {
        const w242 = new PacketWriter(ServerOpcode.SmsSendResult);
        w242.writeU8(12); // 12 = CannotSendMsgMySelf (`sub_4838E8`)
        session.sendPacket(w242);
        break;
      }

      const receiver = receiverName ? state.db.getUserByUsername(receiverName) : null;
      if (!receiver) {
        const w242 = new PacketWriter(ServerOpcode.SmsSendResult);
        w242.writeU8(11); // 11 = WrongIDForSMS (`sub_4838E8`)
        session.sendPacket(w242);
        break;
      }

      state.db.sendSms(receiver.id, senderName, message);

      const w242 = new PacketWriter(ServerOpcode.SmsSendResult);
      w242.writeU8(10); // 10 = MessageSuccess (`sub_4838E8`)
      session.sendPacket(w242);

      const receiverSession = state.findSessionByUsername(receiverName);
      if (receiverSession) {
        const w246 = new PacketWriter(ServerOpcode.SmsNewNotice);
        w246.writeU8(1); // 1 = new mail popup (`sub_5E369D`)
        receiverSession.sendPacket(w246);
      }
      break;
    }

    case ClientOpcode.SmsQuery: {
      // C->S 298 (`CSmsDlg::sub_47F58F` mode=0 / `sub_5E415C` mode=1): `[str username, u8 mode]`
      const username =
        reader.remaining >= 2 ? reader.readString() : (session.users[0]?.username ?? "");
      const mode = reader.remaining >= 1 ? reader.readU8() : 0;
      const targetUser =
        (username ? state.db.getUserByUsername(username) : null) ?? session.users[0] ?? null;

      if (mode === 1) {
        const hasUnread = targetUser ? state.db.hasUnreadSms(targetUser.id) : false;
        const w246 = new PacketWriter(ServerOpcode.SmsNewNotice);
        w246.writeU8(hasUnread ? 1 : 0);
        session.sendPacket(w246);
      } else {
        session.sendPacket(buildSmsListPacket243(state, targetUser));
      }
      break;
    }

    case ClientOpcode.SmsDelete: {
      // C->S 299 (`CSmsDlg::sub_47FDCB`: `[str username, u32 msgId]`) -> S->C 244 (`sub_47F653`)
      const username =
        reader.remaining >= 2 ? reader.readString() : (session.users[0]?.username ?? "");
      const msgId = reader.remaining >= 4 ? reader.readU32() : 0;
      const targetUser =
        (username ? state.db.getUserByUsername(username) : null) ?? session.users[0] ?? null;
      if (targetUser) {
        state.db.deleteSms(targetUser.id, msgId);
      }
      const w244 = new PacketWriter(ServerOpcode.SmsDeleteResult);
      w244.writeU8(1);
      session.sendPacket(w244);
      break;
    }

    case ClientOpcode.SmsDeleteAll: {
      // C->S 300 (`CSmsDlg::sub_47F5F7`: `[str username]`) -> S->C 245 (`sub_47F66A`)
      const username =
        reader.remaining >= 2 ? reader.readString() : (session.users[0]?.username ?? "");
      const targetUser =
        (username ? state.db.getUserByUsername(username) : null) ?? session.users[0] ?? null;
      if (targetUser) {
        state.db.deleteAllSms(targetUser.id);
      }
      const w245 = new PacketWriter(ServerOpcode.SmsDeleteAllResult);
      w245.writeU8(1);
      session.sendPacket(w245);
      break;
    }

    case ClientOpcode.CouplePropose: {
      // C->S 304 (`CCouple::sub_5BA82D`: `[u8 playerIdx, str partnerName, str message]`)
      const playerIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const partnerName = reader.remaining >= 2 ? reader.readString() : "";
      const message = reader.remaining >= 2 ? reader.readString() : "";
      const proposer = session.users[playerIdx] ?? session.users[0];
      const partner = partnerName ? state.db.getUserByUsername(partnerName) : null;

      if (!proposer || !partner) {
        const w252 = new PacketWriter(ServerOpcode.CoupleProposeStatus);
        w252.writeU8(playerIdx);
        w252.writeU8(3); // 3 = CanNotPropose (`sub_5BAE51`)
        w252.writeString(partnerName);
        session.sendPacket(w252);
        break;
      }

      // Send S->C 252 / 253 status=2 (waiting) to proposer (`sub_5BBAA7`)
      const w252 = new PacketWriter(ServerOpcode.CoupleProposeStatus);
      w252.writeU8(playerIdx);
      w252.writeU8(2);
      w252.writeString(partner.username);
      session.sendPacket(w252);

      // If partner is online, send S->C 251 incoming proposal (`sub_5BAA90`)
      const partnerSession = state.findSessionByUsername(partner.username);
      if (partnerSession) {
        const w251 = new PacketWriter(ServerOpcode.CoupleProposeIncoming);
        w251.writeU8(0); // targetPlayerIdx
        w251.writeString(proposer.username);
        w251.writeString(message);
        w251.writeU8(1); // coupleGrade
        partnerSession.sendPacket(w251);
      }

      // Persist couple relationship in SQLite so immediate acceptance or query works
      state.db.setCouple(proposer.id, proposer.username, partner.id, partner.username, 1);
      break;
    }

    case ClientOpcode.CoupleRespond: {
      // C->S 305 (`CCouple::sub_5B9FD6`: `[u8 playerIdx, u8 accept]`)
      const playerIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const accept = reader.remaining >= 1 ? reader.readU8() : 1;
      const responder = session.users[playerIdx] ?? session.users[0];
      const couple = responder ? state.db.getCoupleInfo(responder.id) : null;
      const partnerName = couple?.partnerName ?? "Partner";

      if (accept !== 0) {
        // Send S->C 253 (`sub_5BBD3E` status=12 couple accepted/congratulate)
        const makeW253 = (pName: string) => {
          const w253 = new PacketWriter(ServerOpcode.CoupleCongratulate);
          w253.writeU8(0);
          w253.writeU8(12); // 12 = accepted (`sub_5BBD3E`)
          w253.writeString(pName);
          w253.writeString(pName);
          w253.writeU8(1); // coupleGrade = 1
          return w253;
        };
        session.sendPacket(makeW253(partnerName));
        const partnerSession = state.findSessionByUsername(partnerName);
        if (partnerSession && responder) {
          partnerSession.sendPacket(makeW253(responder.username));
        }
      } else {
        if (responder) {
          state.db.breakupCouple(responder.id);
        }
        const partnerSession = state.findSessionByUsername(partnerName);
        if (partnerSession && responder) {
          const w252 = new PacketWriter(ServerOpcode.CoupleProposeStatus);
          w252.writeU8(0);
          w252.writeU8(14); // 14 = ProposeRejected (`sub_5BAE51`)
          w252.writeString(responder.username);
          partnerSession.sendPacket(w252);
        }
      }
      break;
    }

    case ClientOpcode.CoupleBreakup: {
      // C->S 306 (`CCouple::sub_5BA899`: `[u8 playerIdx]`) -> S->C 254 (`sub_5BC155`)
      const playerIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const user = session.users[playerIdx] ?? session.users[0];
      if (user) {
        const oldCouple = state.db.breakupCouple(user.id);
        if (oldCouple) {
          const partnerSession = state.findSessionByUsername(oldCouple.partnerName);
          if (partnerSession) {
            const w254 = new PacketWriter(ServerOpcode.CoupleBreakupNotice);
            w254.writeU8(0);
            partnerSession.sendPacket(w254);
          }
        }
      }
      const w254 = new PacketWriter(ServerOpcode.CoupleBreakupNotice);
      w254.writeU8(playerIdx);
      session.sendPacket(w254);
      break;
    }
  }
}
