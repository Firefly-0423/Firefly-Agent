import { useEffect, useState } from "react";
import { Modal } from "antd";
import { Folder, FolderPlus, Lightbulb } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { chatStore } from "../pages/chat-page-bridge";
import "./CreateProjectDialog.css";

const NAME_LIMIT = 120;

type PickedFolder = { path: string; displayName?: string };

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 能创建时返回目标文件夹和项目名：名字留空就用文件夹名；还没选文件夹时返回 null。 */
export function projectDraftResult(draft: { name: string; folder?: PickedFolder }): { path: string; displayName: string } | null {
  if (!draft.folder) return null;
  const typed = draft.name.trim().slice(0, NAME_LIMIT);
  return { path: draft.folder.path, displayName: typed || draft.folder.displayName || folderName(draft.folder.path) };
}

/** 侧栏「项目」旁的「+」：给项目起名、选一个源文件夹，创建后在这个项目里开始一段新对话。 */
export function CreateProjectDialog({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (path: string, displayName: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<PickedFolder | undefined>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setFolder(undefined);
    setError(null);
  }, [open]);

  const pick = async () => {
    setPicking(true);
    setError(null);
    try {
      const picked = await chatStore()?.pickWorkspaceFolder?.();
      if (picked?.ok && picked.path) setFolder({ path: picked.path, displayName: picked.displayName });
      else if (picked && !picked.ok && picked.error) setError(picked.error);
    } finally {
      setPicking(false);
    }
  };

  const result = projectDraftResult({ name, folder });
  const create = () => {
    if (!result) return;
    onCreate(result.path, result.displayName);
    onClose();
  };

  return (
    <Modal className="ff-create-project-modal" open={open} title={t("sidebar.createProject.title")} width={460} centered footer={null}
      onCancel={onClose} destroyOnHidden>
      <form className="ff-create-project" onSubmit={(event) => { event.preventDefault(); create(); }}>
        <label className="ff-create-project__label" htmlFor="ff-create-project-name">{t("sidebar.createProject.nameLabel")}</label>
        <div className="ff-create-project__name">
          <Folder size={16} strokeWidth={1.6} aria-hidden="true" />
          <input id="ff-create-project-name" value={name} maxLength={NAME_LIMIT} autoFocus
            placeholder={folder ? folder.displayName ?? folderName(folder.path) : t("sidebar.createProject.namePlaceholder")}
            onChange={(event) => setName(event.target.value)} />
        </div>

        <span className="ff-create-project__label">{t("sidebar.createProject.folderLabel")}</span>
        <div className="ff-create-project__folder">
          {folder ? (
            <div className="ff-create-project__picked">
              <Folder size={16} strokeWidth={1.6} aria-hidden="true" />
              <span className="ff-create-project__picked-text">
                <strong>{folder.displayName ?? folderName(folder.path)}</strong>
                <small title={folder.path}>{folder.path}</small>
              </span>
              <button type="button" className="ff-create-project__ghost" disabled={picking} onClick={() => { void pick(); }}>
                {t("sidebar.createProject.changeFolder")}
              </button>
            </div>
          ) : (
            <>
              <span className="ff-create-project__folder-hint">{t("sidebar.createProject.folderHint")}</span>
              <button type="button" className="ff-create-project__ghost" disabled={picking} onClick={() => { void pick(); }}>
                <FolderPlus size={15} strokeWidth={1.6} aria-hidden="true" />{t("sidebar.createProject.addFolder")}
              </button>
            </>
          )}
        </div>
        {error && <p className="ff-create-project__error" role="alert">{error}</p>}

        <p className="ff-create-project__tip">
          <Lightbulb size={16} strokeWidth={1.6} aria-hidden="true" />
          <span>{t("sidebar.createProject.tip")}</span>
        </p>

        <div className="ff-create-project__footer">
          <button type="submit" className="ff-create-project__submit" disabled={!result}>{t("sidebar.createProject.submit")}</button>
        </div>
      </form>
    </Modal>
  );
}
