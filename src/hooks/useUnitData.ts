import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  formatDbError,
  getDoc,
  isPermissionDeniedError,
  isTransientDbError,
  onDbReconnect,
  onSnapshot,
  OperationType,
  query,
  reconnectDb,
  where,
  db,
} from '../lib/supabaseDb';
import { useAuth } from '../context/AuthContext';
import {
  DEFAULT_LOGBOOK_TEMPLATE,
  LOGBOOK_TEMPLATE_DOC_ID,
  mergeWithDefaultTemplate,
} from '../lib/logbookTemplate';
import type {
  ActionCategory,
  Doctor,
  DoctorScheduleEntry,
  LogbookEntry,
  LogbookFormTemplate,
  LogbookLock,
  Machine,
  MachineLock,
  Patient,
  PjShiftAssignmentEntry,
  ReportEntry,
  ScheduleEntry,
  StaffDirectoryEntry,
  UserProfile,
} from '../types';

function getRecentDateBoundary(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function useUnitData() {
  const { authReady, authUser, userProfile } = useAuth();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [actionCategories, setActionCategories] = useState<ActionCategory[]>([]);
  const [staffDirectory, setStaffDirectory] = useState<StaffDirectoryEntry[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);

  const [approvedLogbooks, setApprovedLogbooks] = useState<LogbookEntry[]>([]);
  const [supervisorPendingLogbooks, setSupervisorPendingLogbooks] = useState<LogbookEntry[]>([]);
  const [logbookLocks, setLogbookLocks] = useState<LogbookLock[]>([]);
  const [machineLocks, setMachineLocks] = useState<MachineLock[]>([]);

  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [pjShiftAssignments, setPjShiftAssignments] = useState<PjShiftAssignmentEntry[]>([]);
  const [doctorSchedules, setDoctorSchedules] = useState<DoctorScheduleEntry[]>([]);
  const [patientReports, setPatientReports] = useState<ReportEntry[]>([]);
  const [unitReports, setUnitReports] = useState<ReportEntry[]>([]);
  const [nurseMonthlyReports, setNurseMonthlyReports] = useState<ReportEntry[]>([]);
  const [formTemplate, setFormTemplate] = useState<LogbookFormTemplate>(DEFAULT_LOGBOOK_TEMPLATE);
  const [loading, setLoading] = useState(true);

  const [approvedReady, setApprovedReady] = useState(false);
  const [supervisorReady, setSupervisorReady] = useState(false);
  const [locksReady, setLocksReady] = useState(false);
  const [machineLocksReady, setMachineLocksReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [resubscribeEpoch, setResubscribeEpoch] = useState(0);
  const hydratedSessionKeyRef = useRef<string | null>(null);
  const prunedLockIdsRef = useRef<Set<string>>(new Set());
  const prunedMachineLockIdsRef = useRef<Set<string>>(new Set());

  const isLeaderOrAdmin =
    userProfile?.role === 'Administrator' ||
    userProfile?.role === 'Managerial' ||
    userProfile?.role === 'Kepala Ruang' ||
    userProfile?.role === 'PJ Shift';

  const isAdmin = userProfile?.role === 'Administrator';

  useEffect(() => {
    if (!authReady || !authUser || !userProfile?.isActive) {
      hydratedSessionKeyRef.current = null;
      setLoading(false);
      return;
    }

    const sessionKey = `${authUser.uid}:${userProfile.role}`;
    const isInitialSessionLoad = hydratedSessionKeyRef.current !== sessionKey;
    hydratedSessionKeyRef.current = sessionKey;

    setFatalError(null);
    if (isInitialSessionLoad) {
      setLoading(true);
      setApprovedReady(false);
      setSupervisorReady(false);
      setLocksReady(false);
      setMachineLocksReady(false);
      prunedLockIdsRef.current.clear();
      prunedMachineLockIdsRef.current.clear();
    }

    const unsubs: (() => void)[] = [];
    let needsResubscribe = false;
    let retryTimer: number | null = null;
    let cancelled = false;

    const handleSnapshotError = (err: unknown, path: string) => {
      if (cancelled) return;
      if (isTransientDbError(err)) {
        needsResubscribe = true;
        setLoading(false);
        console.warn(`Sinkronisasi ${path} terputus sementara, menyambungkan ulang...`);
        void reconnectDb({ force: true, resubscribe: true, reason: 'error' });
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          if (!cancelled && (typeof navigator === 'undefined' || navigator.onLine)) {
            setResubscribeEpoch((e) => e + 1);
          }
        }, 3000);
        return;
      }
      if (isPermissionDeniedError(err)) {
        setFatalError(formatDbError(err, OperationType.LIST, path));
        return;
      }
      setFatalError(formatDbError(err, OperationType.LIST, path));
    };

    const unsubReconnect = onDbReconnect((event) => {
      if (!cancelled && (needsResubscribe || event.shouldResubscribe)) {
        needsResubscribe = false;
        setResubscribeEpoch((e) => e + 1);
      }
    });

    const lockWindowStartDate = getRecentDateBoundary(60);

    // 1. Patients
    unsubs.push(
      onSnapshot<Patient>(
        query(collection(db, 'patients'), where('status', 'in', ['Aktif', 'Rujuk', 'Meninggal', 'Nonaktif'])),
        (snap) => {
          const items = snap.docs.map((d) => ({ ...d.data(), id: d.id } as Patient));
          items.sort((a, b) => a.fullName.localeCompare(b.fullName));
          setPatients(items);
          setLoading(false);
        },
        (err) => handleSnapshotError(err, 'patients')
      )
    );

    // 2. Doctors
    unsubs.push(
      onSnapshot<Doctor>(
        query(collection(db, 'doctors'), where('status', 'in', ['Aktif', 'Cuti', 'Nonaktif'])),
        (snap) => {
          const items = snap.docs.map((d) => ({ ...d.data(), id: d.id } as Doctor));
          items.sort((a, b) => a.fullName.localeCompare(b.fullName));
          setDoctors(items);
        },
        (err) => handleSnapshotError(err, 'doctors')
      )
    );

    // 3. Machines
    unsubs.push(
      onSnapshot<Machine>(
        query(collection(db, 'machines'), where('status', 'in', ['Ready', 'In Use', 'Maintenance', 'Sterilisasi'])),
        (snap) => {
          const items = snap.docs.map((d) => ({ ...d.data(), id: d.id } as Machine));
          items.sort((a, b) => a.machineNumber.localeCompare(b.machineNumber));
          setMachines(items);
        },
        (err) => handleSnapshotError(err, 'machines')
      )
    );

    // 4. Action Categories
    unsubs.push(
      onSnapshot<ActionCategory>(
        query(collection(db, 'action_categories'), where('isActive', 'in', [true, false])),
        (snap) => {
          const items = snap.docs.map((d) => ({ ...d.data(), id: d.id } as ActionCategory));
          items.sort((a, b) => a.name.localeCompare(b.name));
          setActionCategories(items);
        },
        (err) => handleSnapshotError(err, 'action_categories')
      )
    );

    // 5. Staff Directory (Non-PII)
    unsubs.push(
      onSnapshot<StaffDirectoryEntry>(
        query(collection(db, 'staff_directory'), where('isActive', 'in', [true, false])),
        (snap) => {
          const items = snap.docs.map((d) => d.data() as StaffDirectoryEntry);
          items.sort((a, b) => a.fullName.localeCompare(b.fullName));
          setStaffDirectory(items);
        },
        (err) => handleSnapshotError(err, 'staff_directory')
      )
    );

    // 6. All Users (Administrator only)
    if (isAdmin) {
      unsubs.push(
        onSnapshot<UserProfile>(
          collection(db, 'users'),
          (snap) => {
            const items = snap.docs.map((d) => d.data() as UserProfile);
            items.sort((a, b) => a.fullName.localeCompare(b.fullName));
            setAllUsers(items);
          },
          (err) => handleSnapshotError(err, 'users')
        )
      );
    } else {
      setAllUsers([]);
    }

    // 7. Logbook: Approved unit logbooks (last 365 days for dashboard charts & reports without unbounded egress)
    const logbookWindowStartDate = getRecentDateBoundary(365);
    unsubs.push(
      onSnapshot<LogbookEntry>(
        query(
          collection(db, 'logbook'),
          where('verificationStatus', '==', 'Approved'),
          where('date', '>=', logbookWindowStartDate)
        ),
        (snap) => {
          setApprovedLogbooks(snap.docs.map((d) => ({ ...d.data(), id: d.id } as LogbookEntry)));
          setApprovedReady(true);
          setLoading(false);
        },
        (err) => handleSnapshotError(err, 'logbook')
      )
    );

    // 8. Logbook: Draft, Pending & Revision unit logbooks
    const targetStatuses = ['Draft', 'Pending', 'Revision'];
    unsubs.push(
      onSnapshot<LogbookEntry>(
        query(collection(db, 'logbook'), where('verificationStatus', 'in', targetStatuses)),
        (snap) => {
          setSupervisorPendingLogbooks(
            snap.docs.map((d) => ({ ...d.data(), id: d.id } as LogbookEntry))
          );
          setSupervisorReady(true);
          setLoading(false);
        },
        (err) => handleSnapshotError(err, 'logbook')
      )
    );

    // 9b. Logbook Locks (active 60-day window)
    unsubs.push(
      onSnapshot<LogbookLock>(
        query(collection(db, 'logbook_locks'), where('date', '>=', lockWindowStartDate)),
        (snap) => {
          setLogbookLocks(snap.docs.map((d) => ({ ...d.data(), id: d.id } as LogbookLock)));
          setLocksReady(true);
        },
        (err) => handleSnapshotError(err, 'logbook_locks')
      )
    );

    // 9c. Machine Locks (active 60-day window)
    unsubs.push(
      onSnapshot<MachineLock>(
        query(collection(db, 'machine_locks'), where('date', '>=', lockWindowStartDate)),
        (snap) => {
          setMachineLocks(snap.docs.map((d) => ({ ...d.data(), id: d.id } as MachineLock)));
          setMachineLocksReady(true);
        },
        (err) => handleSnapshotError(err, 'machine_locks')
      )
    );

    // 10. Schedules
    if (isLeaderOrAdmin) {
      unsubs.push(
        onSnapshot<ScheduleEntry>(
          query(
            collection(db, 'schedules'),
            where('shift', 'in', ['Pagi', 'Siang', 'Malam', 'Libur', 'Cuti'])
          ),
          (snap) => {
            setSchedules(snap.docs.map((d) => ({ ...d.data(), id: d.id } as ScheduleEntry)));
          },
          (err) => handleSnapshotError(err, 'schedules')
        )
      );
    } else {
      unsubs.push(
        onSnapshot<ScheduleEntry>(
          query(collection(db, 'schedules'), where('nurseId', '==', authUser.uid)),
          (snap) => {
            setSchedules(snap.docs.map((d) => ({ ...d.data(), id: d.id } as ScheduleEntry)));
          },
          (err) => handleSnapshotError(err, 'schedules')
        )
      );
    }

    // 10b. Doctor Schedules
    unsubs.push(
      onSnapshot<DoctorScheduleEntry>(
        query(collection(db, 'doctor_schedules'), where('shift', 'in', ['Pagi', 'Siang', 'Malam'])),
        (snap) => {
          setDoctorSchedules(
            snap.docs.map((d) => ({ ...d.data(), id: d.id } as DoctorScheduleEntry))
          );
        },
        (err) => handleSnapshotError(err, 'doctor_schedules')
      )
    );

    // 10c. PJ Shift Assignments
    unsubs.push(
      onSnapshot<PjShiftAssignmentEntry>(
        query(
          collection(db, 'pj_shift_assignments'),
          where('shift', 'in', ['Pagi', 'Siang', 'Malam'])
        ),
        (snap) => {
          setPjShiftAssignments(
            snap.docs.map((d) => ({ ...d.data(), id: d.id } as PjShiftAssignmentEntry))
          );
        },
        (err) => handleSnapshotError(err, 'pj_shift_assignments')
      )
    );

    // 11. Reports: Patient care
    unsubs.push(
      onSnapshot<ReportEntry>(
        query(collection(db, 'reports'), where('reportType', '==', 'patient_care')),
        (snap) => {
          setPatientReports(snap.docs.map((d) => ({ ...d.data(), id: d.id } as ReportEntry)));
        },
        (err) => handleSnapshotError(err, 'reports')
      )
    );

    // 12. Reports: PJ Shift & Monthly Unit
    if (isLeaderOrAdmin) {
      setNurseMonthlyReports([]);
      unsubs.push(
        onSnapshot<ReportEntry>(
          query(collection(db, 'reports'), where('reportType', 'in', ['pj_shift', 'monthly_unit'])),
          (snap) => {
            setUnitReports(snap.docs.map((d) => ({ ...d.data(), id: d.id } as ReportEntry)));
          },
          (err) => handleSnapshotError(err, 'reports')
        )
      );
    } else {
      unsubs.push(
        onSnapshot<ReportEntry>(
          query(collection(db, 'reports'), where('authorId', '==', authUser.uid)),
          (snap) => {
            setUnitReports(snap.docs.map((d) => ({ ...d.data(), id: d.id } as ReportEntry)));
          },
          (err) => handleSnapshotError(err, 'reports')
        )
      );
      unsubs.push(
        onSnapshot<ReportEntry>(
          query(
            collection(db, 'reports'),
            where('reportType', '==', 'monthly_unit'),
            where('targetNurseId', '==', authUser.uid)
          ),
          (snap) => {
            setNurseMonthlyReports(
              snap.docs.map((d) => ({ ...d.data(), id: d.id } as ReportEntry))
            );
          },
          (err) => handleSnapshotError(err, 'reports')
        )
      );
    }

    // 13. Dynamic Logbook Form Template
    unsubs.push(
      onSnapshot<Partial<LogbookFormTemplate>>(
        doc(db, 'form_templates', LOGBOOK_TEMPLATE_DOC_ID),
        (snap) => {
          if (snap.exists()) {
            setFormTemplate(
              mergeWithDefaultTemplate({
                id: snap.id,
                ...(snap.data() as Partial<LogbookFormTemplate>),
              })
            );
          } else {
            setFormTemplate(DEFAULT_LOGBOOK_TEMPLATE);
          }
        },
        (err) => {
          if (isTransientDbError(err)) {
            handleSnapshotError(err, `form_templates/${LOGBOOK_TEMPLATE_DOC_ID}`);
          } else {
            console.warn('Gagal membaca template logbook kustom, menggunakan default:', err);
          }
        }
      )
    );

    return () => {
      cancelled = true;
      unsubReconnect();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubs.forEach((fn) => fn());
    };
  }, [authReady, authUser?.uid, userProfile?.role, userProfile?.isActive, isLeaderOrAdmin, isAdmin, resubscribeEpoch]);

  if (fatalError) {
    throw new Error(fatalError);
  }

  const allLogbooks = useMemo(() => {
    const map = new Map<string, LogbookEntry>();
    for (const item of approvedLogbooks) map.set(item.id, item);
    for (const item of supervisorPendingLogbooks) map.set(item.id, item);
    return Array.from(map.values()).sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date);
      if (dateCmp !== 0) return dateCmp;
      return b.startTime.localeCompare(a.startTime);
    });
  }, [approvedLogbooks, supervisorPendingLogbooks]);

  const ownLogbooks = useMemo(() => {
    const uid = authUser?.uid;
    if (!uid) return [];
    return allLogbooks.filter((item) => item.nurseId === uid);
  }, [allLogbooks, authUser?.uid]);

  // Automatically prune orphaned logbook_locks whose referenced logbook was already deleted
  useEffect(() => {
    if (!authUser || !userProfile?.isActive) return;
    if (!locksReady || !approvedReady || !supervisorReady) return;

    const timer = window.setTimeout(() => {
      const existingLogbookIds = new Set(allLogbooks.map((lb) => lb.id));
      for (const lk of logbookLocks) {
        const pruneKey = `${lk.id}::${lk.logbookId}`;
        if (prunedLockIdsRef.current.has(pruneKey) || existingLogbookIds.has(lk.logbookId)) {
          continue;
        }
        prunedLockIdsRef.current.add(pruneKey);

        if (isAdmin || lk.nurseId === authUser.uid) {
          deleteDoc(doc(db, 'logbook_locks', lk.id)).catch(() => {
            prunedLockIdsRef.current.delete(pruneKey);
          });
        } else {
          getDoc(doc(db, 'logbook', lk.logbookId))
            .then((snap) => {
              if (!snap.exists()) {
                return deleteDoc(doc(db, 'logbook_locks', lk.id));
              }
            })
            .catch(() => undefined);
        }
      }
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [
    authUser,
    userProfile?.isActive,
    isAdmin,
    locksReady,
    approvedReady,
    supervisorReady,
    allLogbooks,
    logbookLocks,
  ]);

  // Automatically prune orphaned machine_locks whose referenced non-empty logbook was deleted
  useEffect(() => {
    if (!authUser || !userProfile?.isActive) return;
    if (!machineLocksReady || !approvedReady || !supervisorReady) return;

    const timer = window.setTimeout(() => {
      const existingLogbookIds = new Set(allLogbooks.map((lb) => lb.id));
      for (const lk of machineLocks) {
        const pruneKey = `${lk.id}::${lk.logbookId || ''}`;
        if (
          !lk.logbookId ||
          prunedMachineLockIdsRef.current.has(pruneKey) ||
          existingLogbookIds.has(lk.logbookId)
        ) {
          continue;
        }
        prunedMachineLockIdsRef.current.add(pruneKey);

        if (isAdmin || lk.nurseId === authUser.uid) {
          deleteDoc(doc(db, 'machine_locks', lk.id)).catch(() => {
            prunedMachineLockIdsRef.current.delete(pruneKey);
          });
        } else {
          getDoc(doc(db, 'logbook', lk.logbookId))
            .then((snap) => {
              if (!snap.exists()) {
                return deleteDoc(doc(db, 'machine_locks', lk.id));
              }
            })
            .catch(() => undefined);
        }
      }
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [
    authUser,
    userProfile?.isActive,
    isAdmin,
    machineLocksReady,
    approvedReady,
    supervisorReady,
    allLogbooks,
    machineLocks,
  ]);

  const allReports = useMemo(() => {
    const map = new Map<string, ReportEntry>();
    for (const r of patientReports) map.set(r.id, r);
    for (const r of unitReports) map.set(r.id, r);
    for (const r of nurseMonthlyReports) map.set(r.id, r);
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [patientReports, unitReports, nurseMonthlyReports]);

  return {
    loading,
    patients,
    doctors,
    machines,
    actionCategories,
    staffDirectory,
    allUsers,
    ownLogbooks,
    approvedLogbooks,
    allLogbooks,
    logbookLocks,
    machineLocks,
    schedules,
    pjShiftAssignments,
    doctorSchedules,
    allReports,
    formTemplate,
  };
}
