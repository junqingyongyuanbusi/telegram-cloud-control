/**
 * AccountImportModal —— 账号矩阵导入向导（四步：选方式 → 填内容 → 预览 → 结果）。
 *
 * 支持四种来源：
 *   phone（手机号清单）/ session_string（StringSession 串）/ session_file（.session 文件）/ tdata（Telegram Desktop 目录 zip）
 *
 * 设计取舍：
 * - 「先预览再导入」：解析结果先摊开给操作员确认（脱敏展示，session 明文不回传页面）；
 * - tdata 需要可选依赖 opentele2，后端报告不可用时，这个入口直接标灰并给替代路径；
 * - 可顺手绑定代理与分组，并按「养号起点从今天算」入库（新号从最严档开始限速）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Segmented, Select, Space, Switch, Table, Tag, Typography, Upload, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { InboxOutlined, RocketOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { accountImportApi, groupApi, proxyApi } from '../../api/endpoints';
import { useAsyncData } from '../../hooks/useAsyncData';
import { notifySuccess, toast } from '../../utils/feedback';
import { isEnglish } from '../../i18n';
import type { ImportItemPreview, ImportResponse, ImportResultItem } from '../../api/types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 导入成功后回调（刷新列表） */
  onImported?: (result: ImportResponse) => void;
}

export default function AccountImportModal({ open, onClose, onImported }: Props) {
  const { t, i18n } = useTranslation('accounts');
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [proxyId, setProxyId] = useState<string | undefined>();
  const [groupId, setGroupId] = useState<string | undefined>();
  const [remark, setRemark] = useState('');
  const [startWarmup, setStartWarmup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportItemPreview[] | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ total: number; ready: number; failed: number } | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);

  const formats = useAsyncData(() => accountImportApi.formats(), [open], { immediate: false });
  const proxies = useAsyncData(() => proxyApi.list(), [open], { immediate: false });
  const groups = useAsyncData(() => groupApi.list(), [open], { immediate: false });

  // 格式列表由后端给：第一项作为默认选中；万一当前选中的被后端移除（比如手机号清单下线）就回退到首项
  useEffect(() => {
    const list = formats.data?.formats ?? [];
    if (!list.length) return;
    if (!list.some((item) => item.kind === kind)) setKind(list[0].kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formats.data]);

  const activeFormat = useMemo(
    () => (formats.data?.formats ?? []).find((item) => item.kind === kind),
    [formats.data, kind],
  );
  const tdataBlocked = kind === 'tdata' && formats.data?.tdata_available === false;

  const buildForm = () => {
    const form = new FormData();
    form.append('kind', kind);
    if (text.trim()) form.append('text', text);
    files.forEach((file) => form.append('files', file));
    form.append('remark', remark);
    form.append('start_warmup', String(startWarmup));
    if (proxyId) form.append('proxy_id', proxyId);
    if (groupId) form.append('group_id', groupId);
    return form;
  };

  const reset = () => {
    setText('');
    setFiles([]);
    setPreview(null);
    setPreviewMeta(null);
    setResult(null);
  };

  const handleParse = async () => {
    if (!text.trim() && files.length === 0) {
      toast.warning(t('importModal.needInputWarning'));
      return;
    }
    setBusy(true);
    try {
      const res = await accountImportApi.parse(buildForm());
      setPreview(res.items);
      setPreviewMeta({ total: res.total, ready: res.ready, failed: res.failed });
      if (res.failed) toast.warning(t('importModal.parseFailedWarning', { count: res.failed }));
    } catch {
      /* client 已统一提示 */
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    try {
      const res = await accountImportApi.run(buildForm());
      setResult(res);
      notifySuccess(res.message);
      onImported?.(res);
    } catch {
      /* client 已统一提示 */
    } finally {
      setBusy(false);
    }
  };

  const previewColumns: ColumnsType<ImportItemPreview> = [
    { title: t('importModal.previewColumns.source'), dataIndex: 'source', width: 110, render: (value: string) => <Tag>{value}</Tag> },
    { title: t('importModal.previewColumns.label'), dataIndex: 'label', width: 200, ellipsis: true },
    {
      title: t('importModal.previewColumns.session'),
      dataIndex: 'has_session',
      width: 80,
      render: (value: boolean) =>
        value ? <Tag color="green">{t('importModal.previewColumns.hasSession')}</Tag> : <Tag>{t('importModal.previewColumns.pendingLogin')}</Tag>,
    },
    { title: t('importModal.previewColumns.dc'), dataIndex: 'dc_id', width: 60, render: (value: number | null) => value ?? '—' },
    {
      title: t('importModal.previewColumns.parseResult'),
      dataIndex: 'error',
      width: 320,
      ellipsis: { showTitle: false },
      render: (value: string | null) => {
        const displayText = value || t('importModal.previewColumns.readyToImport');
        return (
          <Tooltip title={displayText} placement="topLeft">
            <span className={value ? 'tg-clamp-cell tg-text-danger' : 'tg-clamp-cell'}>{displayText}</span>
          </Tooltip>
        );
      },
    },
  ];

  const resultColumns: ColumnsType<ImportResultItem> = [
    { title: t('importModal.resultColumns.label'), dataIndex: 'label', width: 200, ellipsis: true },
    {
      title: t('importModal.resultColumns.result'),
      dataIndex: 'ok',
      width: 90,
      render: (value: boolean) =>
        value ? <Tag color="green">{t('importModal.resultColumns.ok')}</Tag> : <Tag color="red">{t('importModal.resultColumns.skipped')}</Tag>,
    },
    { title: t('importModal.resultColumns.message'), dataIndex: 'message', ellipsis: true },
  ];

  const english = isEnglish(i18n.language);
  const formatLabelOf = (item: { kind: string; label: string }) =>
    english
      ? t(`importModal.formatLabels.${item.kind}`, { defaultValue: item.label })
      : item.label || t(`importModal.formatLabels.${item.kind}`, { defaultValue: item.kind });

  const formatTipOf = (k: string, backendDesc?: string) =>
    english
      ? t(`importModal.tips.${k}`, { defaultValue: backendDesc ?? '' })
      : backendDesc || t(`importModal.tips.${k}`, { defaultValue: '' });

  return (
    <Modal
      open={open}
      title={t('importModal.title')}
      width={860}
      onCancel={() => {
        reset();
        onClose();
      }}
      footer={
        <Space>
          <Button onClick={handleParse} loading={busy} disabled={tdataBlocked}>
            {t('importModal.previewBtn')}
          </Button>
          <Button
            type="primary"
            icon={<RocketOutlined />}
            loading={busy}
            disabled={tdataBlocked}
            onClick={() => void handleImport()}
          >
            {t('importModal.startBtn')}
          </Button>
        </Space>
      }
      afterOpenChange={(visible) => {
        if (!visible) return;
        void formats.reload();
        void proxies.reload();
        void groups.reload();
      }}
    >
      <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
        <Segmented
          value={kind}
          onChange={(value) => {
            setKind(String(value));
            setPreview(null);
            setResult(null);
          }}
          options={(formats.data?.formats ?? []).map((item) => ({ label: formatLabelOf(item), value: item.kind }))}
          block
        />

        <Alert
          type={tdataBlocked ? 'warning' : 'info'}
          showIcon
          message={activeFormat ? formatLabelOf(activeFormat) : t('importModal.defaultModeTitle')}
          description={
            <>
              {formatTipOf(kind, activeFormat?.description)}
              {tdataBlocked ? (
                <>
                  <br />
                  {english ? t('importModal.tdataUnavailableHint') : activeFormat?.hint ?? t('importModal.tdataUnavailableHint')}
                </>
              ) : null}
            </>
          }
        />

        {kind === 'phone' || kind === 'session_string' ? (
          <Input.TextArea
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              kind === 'phone'
                ? t('importModal.phonePlaceholder')
                : t('importModal.sessionPlaceholder')
            }
            style={{ fontFamily: 'var(--tg-font-family-mono, monospace)' }}
          />
        ) : (
          <Upload.Dragger
            multiple
            accept={activeFormat?.accept}
            fileList={files.map((file, index) => ({ uid: String(index), name: file.name }))}
            beforeUpload={(file) => {
              setFiles((prev) => [...prev.filter((item) => item.name !== file.name), file as File]);
              return false; // 交给「开始导入」统一提交
            }}
            onRemove={(file) => setFiles((prev) => prev.filter((item) => item.name !== file.name))}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">
              {t('importModal.dragText', { accept: activeFormat?.accept ?? '.session / .zip' })}
            </p>
            <p className="ant-upload-hint">{t('importModal.dragHint')}</p>
          </Upload.Dragger>
        )}

        <Form layout="vertical" size="small">
          <Space wrap align="start">
            <Form.Item label={t('importModal.bindProxy')} style={{ marginBottom: 0 }}>
              <Select
                allowClear
                style={{ width: 200 }}
                placeholder={t('importModal.noProxy')}
                value={proxyId}
                loading={proxies.loading}
                onChange={setProxyId}
                options={(proxies.data ?? []).map((item) => ({ value: item.id, label: `${item.name} (${item.endpoint})` }))}
              />
            </Form.Item>
            <Form.Item label={t('importModal.assignGroup')} style={{ marginBottom: 0 }}>
              <Select
                allowClear
                style={{ width: 180 }}
                placeholder={t('importModal.noGroup')}
                value={groupId}
                loading={groups.loading}
                onChange={setGroupId}
                options={(groups.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
              />
            </Form.Item>
            <Form.Item label={t('importModal.remark')} style={{ marginBottom: 0 }}>
              <Input
                style={{ width: 200 }}
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                placeholder={t('importModal.remarkPlaceholder')}
              />
            </Form.Item>
            <Form.Item label={t('importModal.warmupStart')} style={{ marginBottom: 0 }}>
              <Switch checked={startWarmup} onChange={setStartWarmup} />
              <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 'var(--tg-font-size-xs)' }}>
                {t('importModal.warmupHint')}
              </Typography.Text>
            </Form.Item>
          </Space>
        </Form>

        {previewMeta ? (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
              {t('importModal.previewSummary', { total: previewMeta.total, ready: previewMeta.ready })}
              {previewMeta.failed ? t('importModal.previewFailedSuffix', { count: previewMeta.failed }) : ''}
            </Typography.Text>
            <Table<ImportItemPreview>
              size="small"
              rowKey={(record, index) => `${record.label}-${index}`}
              columns={previewColumns}
              dataSource={preview ?? []}
              pagination={{ pageSize: 6, size: 'small' }}
              style={{ marginTop: 'var(--tg-space-md)' }}
            />
          </div>
        ) : null}

        {result ? (
          <Alert
            type={result.failed ? 'warning' : 'success'}
            showIcon
            message={result.message}
            description={
              <Table<ImportResultItem>
                size="small"
                rowKey={(record) => `${record.index}-${record.label}`}
                columns={resultColumns}
                dataSource={result.results}
                pagination={{ pageSize: 6, size: 'small' }}
              />
            }
          />
        ) : null}
      </div>
    </Modal>
  );
}
