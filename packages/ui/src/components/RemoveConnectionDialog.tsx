import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SettingCheck } from './SettingsSection.js';
import { formatBytes } from './model-memory-copy.js';

type Stored = { files: number; bytes: number } | 'counting' | 'unknown';

/**
 * Confirm removing a connection. What it downloaded stays unless the person
 * ticks "Also delete what it downloaded": for mail the originals are still at
 * the provider, but for a feed or a social account the copy here may be the
 * only one left, so keeping is the default. A camera keeps its own wording;
 * its pictures are handled by the camera card.
 */
export function RemoveConnectionDialog({
  projectId,
  binding,
  onConfirm,
  onCancel,
}: {
  projectId: string;
  binding: { id: string; driver?: string } | null;
  onConfirm: (deleteData: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const [stored, setStored] = useState<Stored>('counting');
  const bindingId = binding?.id ?? null;
  const isDevice = binding?.driver === 'device';

  useEffect(() => {
    setDeleteData(false);
    if (!bindingId || isDevice) return;
    let live = true;
    setStored('counting');
    api
      .connectorStoredData(projectId, bindingId)
      .then((data) => {
        if (live) setStored(data);
      })
      .catch(() => {
        if (live) setStored('unknown');
      });
    return () => {
      live = false;
    };
  }, [projectId, bindingId, isDevice]);

  const nothingStored = typeof stored === 'object' && stored.files === 0;
  const hint =
    stored === 'counting'
      ? 'Counting what it downloaded…'
      : stored === 'unknown'
        ? 'The originals at the source stay where they are.'
        : `${stored.files.toLocaleString()} ${stored.files === 1 ? 'file' : 'files'}, ${formatBytes(stored.bytes)}, in this project. The originals at the source stay where they are.`;

  return (
    <ConfirmDialog
      open={binding !== null}
      title="Remove connection?"
      message={
        isDevice
          ? 'This stops the camera and deletes the pictures it saved on this computer. The moments it recorded stay in the project.'
          : deleteData
            ? 'This removes the connection, its saved sign-in, and everything it downloaded into this project.'
            : nothingStored
              ? 'This removes the connection and its saved sign-in. It has not downloaded anything.'
              : 'This removes the connection and its saved sign-in. What it downloaded stays in the project.'
      }
      confirmLabel={deleteData ? 'Remove and delete' : 'Remove'}
      danger
      onConfirm={() => onConfirm(deleteData && !isDevice)}
      onCancel={onCancel}
    >
      {!isDevice && !nothingStored && (
        <SettingCheck
          label="Also delete what it downloaded"
          hint={hint}
          checked={deleteData}
          onChange={setDeleteData}
        />
      )}
    </ConfirmDialog>
  );
}
