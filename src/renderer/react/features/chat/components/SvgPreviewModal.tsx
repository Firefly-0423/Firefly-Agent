import { Modal } from "antd";
import { useTranslation } from "../../../i18n";

type SvgPreviewProps = {
  svg: string;
  open: boolean;
  onClose: () => void;
};

export function SvgPreviewModal({ svg, open, onClose }: SvgPreviewProps) {
  const { t } = useTranslation();
  const preview = <div dangerouslySetInnerHTML={{ __html: svg }} className="ff-svg-preview" />;
  return <Modal className="ff-svg-preview-modal" destroyOnHidden width="min(1200px, 92vw)"
    title={t("messageList.diagramPreview")} footer={null} onCancel={onClose} open={open}>
    {preview}
  </Modal>;
}
