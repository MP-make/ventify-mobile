import { onSnapshot, type DocumentData, type DocumentReference, type DocumentSnapshot, type FirestoreError } from 'firebase/firestore';

/** The listener supplies both the initial value and future updates. */
export function subscribeLiveDocument<T extends DocumentData>(
  reference: DocumentReference<T>,
  apply: (snapshot: DocumentSnapshot<T>) => void,
  onError: (error: FirestoreError) => void,
  includeMetadata: boolean = false,
): () => void {
  let active = true;
  const unsubscribe = onSnapshot(reference, { includeMetadataChanges: includeMetadata },
    snapshot => { if (active) apply(snapshot); },
    error => { if (active) onError(error); },
  );
  return () => { active = false; unsubscribe(); };
}
