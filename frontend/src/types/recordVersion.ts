/**
 * 现场记录历史版本：记录每次修改「动手前」的内容快照。
 * 与 records 行的 revision 对应，构成现场记录侧的可追溯链：
 * 补记 / 更正旧记录前先快照，重算失败或需要回溯时能看到旧记录原貌。
 */
export interface RecordVersion {
  id: string
  /** 所属现场记录 */
  recordId: string
  /** 所属要素（冗余，便于按要素追溯） */
  elementId: string
  /** 快照所属行版本号（对应记录修改前的 revision） */
  revision: number
  /** 快照内容 */
  shootDayId: string
  sceneId: string
  takeNo: string
  currentState: string
  photoNote: string
  recordedBy: string
  /** 变更说明（如「更正镜次 3/1 状态描述」「删除前快照」） */
  changeNote: string
  /** 快照时间（毫秒时间戳） */
  createdAt: number
}

export type RecordVersionRow = RecordVersion

/** 由记录行生成一版修改前快照 */
export function snapshotRecord(
  record: {
    id: string
    elementId: string
    shootDayId: string
    sceneId: string
    takeNo: string
    currentState: string
    photoNote: string
    recordedBy: string
    revision: number
  },
  id: string,
  changeNote: string,
  createdAt: number
): RecordVersion {
  return {
    id,
    recordId: record.id,
    elementId: record.elementId,
    revision: record.revision,
    shootDayId: record.shootDayId,
    sceneId: record.sceneId,
    takeNo: record.takeNo,
    currentState: record.currentState,
    photoNote: record.photoNote,
    recordedBy: record.recordedBy,
    changeNote,
    createdAt
  }
}
