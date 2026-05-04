import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, BookOpen, RotateCcw, Check, X, LogIn, Save, Award, Timer, Info } from 'lucide-react';
import { COUNTRIES } from './data/countries';
import { auth, db, loginWithGoogle, handleFirestoreError, OperationType } from './lib/firebase';
import { onAuthStateChanged, User as FirebaseUser, signOut } from 'firebase/auth';
import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  setDoc, 
  doc, 
  deleteDoc,
  serverTimestamp 
} from 'firebase/firestore';

type GameState = 'playing' | 'collection' | 'leaderboard';
type GameMode = 'normal' | 'timeAttack';
type TimeAttackStatus = 'idle' | 'running' | 'finished';
type FlagStatus = 'pending' | 'collected' | 'failed';

interface ScoreEntry {
  userId: string;
  displayName: string;
  photoURL?: string;
  flagsCount: number;
  totalTime: number;
  timeAttackScore?: number;
  updatedAt: {
    seconds: number;
    nanoseconds: number;
  } | {
    toDate: () => Date;
  };
}

const TIME_ATTACK_DURATION = 300; // 5 minutes

const DIFFICULTY_ORDER = {
  common: 0,
  rare: 1,
  epic: 2,
  secret: 3,
};

const DIFFICULTY_LABELS = {
  common: 'Común',
  rare: 'Raro',
  epic: 'Épico',
  secret: 'Secreto',
};

const DIFFICULTY_COLORS = {
  common: 'bg-green-100 text-green-700 border-green-200',
  rare: 'bg-blue-100 text-blue-700 border-blue-200',
  epic: 'bg-purple-100 text-purple-700 border-purple-200',
  secret: 'bg-amber-100 text-amber-700 border-amber-200',
};

export default function App() {
  const [view, setView] = useState<GameState>('playing');
  const [mode, setMode] = useState<GameMode>('normal');
  const [timeAttackStatus, setTimeAttackStatus] = useState<TimeAttackStatus>('idle');
  const [timeAttackLeft, setTimeAttackLeft] = useState(TIME_ATTACK_DURATION);
  const [timeAttackCurrentScore, setTimeAttackCurrentScore] = useState(0);
  const [timeAttackSeenIndices, setTimeAttackSeenIndices] = useState<number[]>([]);
  
  const [isSaving, setIsSaving] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [results, setResults] = useState<Record<string, FlagStatus>>(() => {
    try {
      const saved = localStorage.getItem('flag-quest-results');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      console.error("Error parsing results from localStorage", e);
      return {};
    }
  });

  const [bestTimeAttackScore, setBestTimeAttackScore] = useState(() => {
    try {
      const saved = localStorage.getItem('flag-quest-best-time-attack');
      return saved ? parseInt(saved, 10) : 0;
    } catch {
      return 0;
    }
  });
  
  const [totalTime, setTotalTime] = useState(() => {
    try {
      const saved = localStorage.getItem('flag-quest-time');
      return saved ? parseInt(saved, 10) : 0;
    } catch {
      return 0;
    }
  });

  const [leaderboard, setLeaderboard] = useState<ScoreEntry[]>([]);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [currentFlagIndex, setCurrentFlagIndex] = useState(-1);
  const [guess, setGuess] = useState('');
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auth Listener
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  // Timer logic
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (view === 'playing' && currentFlagIndex !== -1 && !feedback) {
      if (mode === 'normal') {
        interval = setInterval(() => {
          setTotalTime(t => {
            const next = t + 1;
            localStorage.setItem('flag-quest-time', next.toString());
            return next;
          });
        }, 1000);
      } else if (mode === 'timeAttack' && timeAttackStatus === 'running') {
        interval = setInterval(() => {
          setTimeAttackLeft(prev => {
            if (prev <= 1) {
              setTimeAttackStatus('finished');
              // Move best score update here
              setTimeAttackCurrentScore(currentScore => {
                setBestTimeAttackScore(best => {
                  if (currentScore > best) {
                    localStorage.setItem('flag-quest-best-time-attack', currentScore.toString());
                    return currentScore;
                  }
                  return best;
                });
                return currentScore;
              });
              clearInterval(interval);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      }
    }
    return () => clearInterval(interval);
  }, [view, currentFlagIndex, feedback, mode, timeAttackStatus]);

  // Removed Handle Best Time Attack Score sync effect as it was moved above

  const [leaderboardMode, setLeaderboardMode] = useState<GameMode>('normal');

  // Leaderboard listener
  useEffect(() => {
    const q = query(
      collection(db, 'leaderboard'),
      orderBy(leaderboardMode === 'normal' ? 'flagsCount' : 'timeAttackScore', 'desc'),
      orderBy(leaderboardMode === 'normal' ? 'totalTime' : 'updatedAt', leaderboardMode === 'normal' ? 'asc' : 'desc'),
      limit(100)
    );
    return onSnapshot(q, 
      (snapshot) => {
        const docs = snapshot.docs.map(d => ({ ...d.data() } as ScoreEntry));
        setLeaderboard(docs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'leaderboard');
      }
    );
  }, [leaderboardMode]);

  // Submit score when results or user changes (Debounced/Optimized)
  useEffect(() => {
    if (user && (Object.keys(results).length > 0 || bestTimeAttackScore > 0)) {
      const collectedCount = Object.values(results).filter(v => v === 'collected').length;
      
      const docRef = doc(db, 'leaderboard', user.uid);
      const updateScore = async () => {
        const path = `leaderboard/${user.uid}`;
        try {
          await setDoc(docRef, {
            userId: user.uid,
            displayName: user.displayName || 'Explorador Anónimo',
            photoURL: user.photoURL || '',
            flagsCount: collectedCount,
            totalTime: totalTime,
            timeAttackScore: bestTimeAttackScore,
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, path);
        }
      };

      // Only update when results change or every 30 seconds to avoid hitting quotas
      const timeout = setTimeout(updateScore, 1000);
      return () => clearTimeout(timeout);
    }
  }, [results, user, bestTimeAttackScore, totalTime]);

  const manualSave = async () => {
    if (!user) return;
    setIsSaving(true);
    const path = `leaderboard/${user.uid}`;
    try {
      const collectedCount = Object.values(results).filter(v => v === 'collected').length;
      const docRef = doc(db, 'leaderboard', user.uid);
      await setDoc(docRef, {
        userId: user.uid,
        displayName: user.displayName || 'Explorador Anónimo',
        photoURL: user.photoURL || '',
        flagsCount: collectedCount,
        totalTime: totalTime,
        timeAttackScore: bestTimeAttackScore,
        updatedAt: serverTimestamp()
      }, { merge: true });
      
      // Feedback visual breve
      setTimeout(() => setIsSaving(false), 1500);
    } catch (err) {
      setIsSaving(false);
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  const sortedCountries = useMemo(() => {
    return [...COUNTRIES].sort((a, b) => 
      DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty]
    );
  }, []);

  const pendingPool = useMemo(() => {
    return sortedCountries.filter(c => results[c.code] !== 'collected');
  }, [results, sortedCountries]);

  // Pick a random flag from the easiest available difficulty group
  useEffect(() => {
    if (currentFlagIndex !== -1 || sortedCountries.length === 0) return;

    if (mode === 'normal') {
      if (pendingPool.length === 0) return;
      // Find the lowest difficulty present
      const minDiff = Math.min(...pendingPool.map(c => DIFFICULTY_ORDER[c.difficulty]));
      const easiestRemaining = pendingPool.filter(c => DIFFICULTY_ORDER[c.difficulty] === minDiff);
      
      // Prefer ones not yet attempted (failed) if possible
      const notAttempted = easiestRemaining.filter(c => !results[c.code]);
      const targetPool = notAttempted.length > 0 ? notAttempted : easiestRemaining;
      
      const randomIndex = Math.floor(Math.random() * targetPool.length);
      const chosen = targetPool[randomIndex];
      const actualIndexInSorted = sortedCountries.findIndex(c => c.code === chosen.code);
      setTimeout(() => setCurrentFlagIndex(actualIndexInSorted), 0);
    } else if (mode === 'timeAttack' && timeAttackStatus === 'running') {
      // Time Attack: Choose a random flag not seen in this session
      const availableIndices = sortedCountries
        .map((_, i) => i)
        .filter(i => !timeAttackSeenIndices.includes(i));
      
      if (availableIndices.length > 0) {
        const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
        setTimeout(() => {
          setCurrentFlagIndex(randomIndex);
          setTimeAttackSeenIndices(prev => [...prev, randomIndex]);
        }, 0);
      } else {
        // All flags seen! (Rare but possible)
        setTimeout(() => setTimeAttackStatus('finished'), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFlagIndex, mode, timeAttackStatus, pendingPool.length]);

  useEffect(() => {
    localStorage.setItem('flag-quest-results', JSON.stringify(results));
  }, [results]);

  const handleGuess = (e: React.FormEvent) => {
    e.preventDefault();
    if (feedback || currentFlagIndex === -1) return;

    const currentCountry = sortedCountries[currentFlagIndex];
    
    // Normalización robusta: quita espacios, pasa a minúsculas y elimina acentos
    const normalize = (text: string) => 
      text.trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const isCorrect = normalize(guess) === normalize(currentCountry.name);

    if (isCorrect) {
      setFeedback('correct');
      if (mode === 'normal') {
        setResults(prev => ({ ...prev, [currentCountry.code]: 'collected' }));
      } else {
        setTimeAttackCurrentScore(prev => prev + 1);
      }
    } else {
      setFeedback('wrong');
      if (mode === 'normal') {
        setResults(prev => ({ ...prev, [currentCountry.code]: 'failed' }));
      }
    }

    setTimeout(() => {
      setFeedback(null);
      setGuess('');
      setCurrentFlagIndex(-1); // This will trigger picking a new one
    }, 1500);
  };

  const confirmReset = () => {
    setResults({});
    setTotalTime(0);
    localStorage.removeItem('flag-quest-time');
    localStorage.removeItem('flag-quest-results');
    setCurrentFlagIndex(-1);
    setView('playing');
    setShowResetConfirm(false);

    // Delete score from leaderboard if user is logged in
    if (user) {
      const path = `leaderboard/${user.uid}`;
      const docRef = doc(db, 'leaderboard', user.uid);
      deleteDoc(docRef).catch(err => handleFirestoreError(err, OperationType.DELETE, path));
    }
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const startTimeAttack = () => {
    setTimeAttackLeft(TIME_ATTACK_DURATION);
    setTimeAttackCurrentScore(0);
    setTimeAttackSeenIndices([]);
    setTimeAttackStatus('running');
    setCurrentFlagIndex(-1);
  };

  const currentCountry = currentFlagIndex !== -1 ? sortedCountries[currentFlagIndex] : null;

  return (
    <div className="min-h-screen flex flex-col font-sans bg-gray-50">
      {/* Header */}
      <header className="p-6 flex items-center justify-between glass-panel sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-brand-primary rounded-xl flex items-center justify-center text-white shadow-lg shadow-orange-200">
            <Trophy size={20} />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">Flag Quest</h1>
            <p className="text-[10px] font-mono uppercase tracking-widest text-gray-500">Global Explorer v1.0</p>
          </div>
        </div>
        
        <nav className="flex gap-2">
          <button 
            onClick={() => { setView('playing'); setMode('normal'); }}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${view === 'playing' && mode === 'normal' ? 'bg-brand-dark text-white' : 'hover:bg-gray-100'}`}
          >
            Normal
          </button>
          <button 
            onClick={() => { setView('playing'); setMode('timeAttack'); }}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${view === 'playing' && mode === 'timeAttack' ? 'bg-brand-dark text-white' : 'hover:bg-gray-100'}`}
          >
            Contrarreloj
          </button>
          <button 
            onClick={() => setView('collection')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${view === 'collection' ? 'bg-brand-dark text-white' : 'hover:bg-gray-100'}`}
          >
            Índice
          </button>
          <button 
            onClick={() => setView('leaderboard')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${view === 'leaderboard' ? 'bg-brand-dark text-white' : 'hover:bg-gray-100'}`}
          >
            Top 100
          </button>
        </nav>

        <div className="hidden md:flex items-center gap-4 ml-4 pl-4 border-l border-gray-100">
          {user ? (
            <div className="flex items-center gap-3">
              <button 
                onClick={manualSave}
                disabled={isSaving}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all shadow-lg shadow-sky-100 ${isSaving ? 'bg-green-500 text-white' : 'bg-sky-400 hover:bg-sky-500 text-white active:scale-95'}`}
              >
                {isSaving ? <Check size={14} /> : <Save size={14} />}
                {isSaving ? 'Guardado' : 'Guardar'}
              </button>
              
              <button 
                onClick={() => signOut(auth)}
                className="flex items-center gap-2 group"
              >
                <img src={user.photoURL || ''} alt="" className="w-8 h-8 rounded-full border-2 border-transparent group-hover:border-brand-primary transition-all" referrerPolicy="no-referrer" />
                <div className="text-right">
                  <p className="text-[10px] font-bold text-gray-900 group-hover:text-brand-primary transition-colors">{user.displayName}</p>
                  <p className="text-[8px] font-mono text-gray-400">LOGOUT</p>
                </div>
              </button>
            </div>
          ) : (
            <button 
              onClick={loginWithGoogle}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
            >
              <LogIn size={16} />
              <span className="text-xs font-bold uppercase tracking-wider">Entrar</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-6 max-w-4xl mx-auto w-full">
        {view === 'playing' ? (
          <AnimatePresence mode="wait">
            {mode === 'timeAttack' && timeAttackStatus === 'idle' ? (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-center space-y-8"
              >
                <div className="w-24 h-24 bg-orange-100 text-brand-primary rounded-[2.5rem] flex items-center justify-center mx-auto shadow-xl shadow-orange-100/50">
                  <Timer size={48} className="animate-pulse" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-4xl font-extrabold italic font-display tracking-tight">Modo Contrarreloj</h2>
                  <p className="text-gray-500 max-w-sm mx-auto">Adivina tantas banderas como puedas en 5 minutos. Tu récord se guardará en el Top 100.</p>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm inline-block">
                  <p className="text-xs font-mono text-gray-400 uppercase tracking-widest mb-1">Tu mejor marca</p>
                  <p className="text-4xl font-black text-brand-dark">{bestTimeAttackScore} <span className="text-sm font-medium text-gray-400">banderas</span></p>
                </div>
                <button 
                  onClick={startTimeAttack}
                  className="w-full max-w-xs bg-brand-dark text-white rounded-2xl py-6 font-bold hover:bg-brand-primary transition-all shadow-xl shadow-gray-200 mt-4 active:scale-95 flex items-center justify-center gap-3"
                >
                  <LogIn size={20} />
                  ¡COMENZAR DESAFÍO!
                </button>
              </motion.div>
            ) : mode === 'timeAttack' && timeAttackStatus === 'finished' ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center space-y-8"
              >
                <div className="w-24 h-24 bg-green-100 text-green-600 rounded-[2.5rem] flex items-center justify-center mx-auto shadow-xl shadow-green-100/50">
                  <Award size={48} />
                </div>
                <div className="space-y-2">
                  <h2 className="text-5xl font-black italic font-display tracking-tighter">¡TIEMPO AGOTADO!</h2>
                  <p className="text-gray-500">Has conseguido identificar</p>
                </div>
                <div className="flex items-center justify-center gap-4">
                  <div className="bg-white p-8 rounded-[2rem] border border-gray-100 shadow-xl">
                    <p className="text-6xl font-black text-brand-dark">{timeAttackCurrentScore}</p>
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400 mt-2">Banderas</p>
                  </div>
                </div>
                {timeAttackCurrentScore >= bestTimeAttackScore && timeAttackCurrentScore > 0 && (
                  <p className="text-brand-primary font-bold animate-bounce flex items-center justify-center gap-2">
                    <Trophy size={16} /> ¡NUEVO RÉCORD PERSONAL!
                  </p>
                )}
                <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
                  <button 
                    onClick={startTimeAttack}
                    className="bg-brand-dark text-white px-10 py-5 rounded-2xl font-bold hover:bg-brand-primary transition-all flex items-center gap-2"
                  >
                    <RotateCcw size={18} /> Reintentar
                  </button>
                  <button 
                    onClick={() => setView('leaderboard')}
                    className="bg-white border-2 border-gray-100 text-gray-600 px-10 py-5 rounded-2xl font-bold hover:bg-gray-50 transition-all"
                  >
                    Ver Ranking
                  </button>
                </div>
              </motion.div>
            ) : currentCountry ? (
              <motion.div
                key={currentCountry.code}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="w-full flex flex-col items-center gap-8"
              >
                {/* Timer and Progress */}
                <div className="flex items-center gap-6 mb-2">
                  <div className={`flex items-center gap-2 font-mono text-xs ${mode === 'timeAttack' && timeAttackLeft < 30 ? 'text-red-500 animate-pulse font-bold' : 'text-gray-400'}`}>
                    <Timer size={14} className={mode === 'timeAttack' ? 'text-brand-primary' : 'text-gray-300'} />
                    <span>{mode === 'normal' ? formatTime(totalTime) : formatTime(timeAttackLeft)}</span>
                  </div>
                  <div className="h-4 w-px bg-gray-200" />
                  {mode === 'timeAttack' ? (
                    <div className="flex items-center gap-2 font-bold text-xs text-brand-dark">
                      <Award size={14} className="text-orange-400" />
                      <span>{timeAttackCurrentScore}</span>
                    </div>
                  ) : (
                    <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${DIFFICULTY_COLORS[currentCountry.difficulty]}`}>
                      {DIFFICULTY_LABELS[currentCountry.difficulty]}
                    </div>
                  )}
                </div>

                {/* Flag Container */}
                <div className="relative group">
                  <div className="absolute -inset-4 bg-gradient-to-tr from-orange-500/10 to-blue-500/10 rounded-[2rem] blur-2xl opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className={`relative overflow-hidden rounded-2xl flag-shadow transition-transform duration-500 group-hover:scale-105 ${feedback === 'wrong' ? 'grayscale-flag' : ''}`}>
                    <img 
                      src={`https://flagcdn.com/w640/${currentCountry.code}.png`} 
                      alt="Guess this flag"
                      className="w-full max-w-md aspect-[3/2] object-cover"
                      referrerPolicy="no-referrer"
                    />
                    {feedback === 'correct' && (
                      <motion.div 
                        initial={{ opacity: 0 }} 
                        animate={{ opacity: 1 }} 
                        className="absolute inset-0 bg-green-500/40 flex items-center justify-center backdrop-blur-[2px]"
                      >
                        <div className="bg-white p-4 rounded-full shadow-xl">
                          <Check className="text-green-600" size={48} />
                        </div>
                      </motion.div>
                    )}
                    {feedback === 'wrong' && (
                      <motion.div 
                        initial={{ opacity: 0 }} 
                        animate={{ opacity: 1 }} 
                        className="absolute inset-0 bg-red-500/20 flex items-center justify-center backdrop-blur-[2px]"
                      >
                        <div className="bg-white p-4 rounded-full shadow-xl">
                          <X className="text-red-600" size={48} />
                        </div>
                      </motion.div>
                    )}
                  </div>
                </div>

                {/* Guess Input */}
                <form onSubmit={handleGuess} className="w-full max-w-sm space-y-4">
                  <div className="relative">
                    <input
                      ref={inputRef}
                      type="text"
                      autoFocus
                      placeholder="Nombre del país..."
                      value={guess}
                      onChange={(e) => setGuess(e.target.value)}
                      disabled={!!feedback}
                      className="w-full bg-white border-2 border-gray-100 rounded-2xl px-6 py-4 text-center text-lg font-bold placeholder:font-medium placeholder:text-gray-300 focus:outline-none focus:border-brand-primary transition-colors shadow-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!!feedback || !guess}
                    className="w-full bg-brand-dark text-white rounded-2xl py-4 font-bold hover:bg-brand-primary transition-colors uppercase tracking-widest text-xs disabled:opacity-50 disabled:hover:bg-brand-dark"
                  >
                    Adivinar
                  </button>
                </form>

                <div className="pt-12 text-center">
                  <p className="text-sm font-medium text-gray-400">
                    {Object.keys(results).filter(k => results[k] === 'collected').length} / {COUNTRIES.length} Banderas Coleccionadas
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                initial={{ opacity: 0 }} 
                animate={{ opacity: 1 }}
                className="text-center space-y-6"
              >
                <div className="w-20 h-20 bg-green-100 text-green-600 rounded-3xl flex items-center justify-center mx-auto mb-8 animate-bounce">
                  <Trophy size={40} />
                </div>
                <h2 className="text-4xl font-extrabold italic font-display">¡Felicidades Explorador!</h2>
                <p className="text-gray-500 max-w-xs mx-auto">Has completado el desafío de banderas de esta sesión.</p>
                <button 
                  onClick={() => setShowResetConfirm(true)}
                  className="flex items-center gap-2 mx-auto text-brand-primary font-bold uppercase tracking-widest text-xs"
                >
                  <RotateCcw size={14} />
                  Reiniciar Desafío
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        ) : view === 'collection' ? (
          <div className="w-full space-y-8 animate-in fade-in duration-500">
            <div className="flex items-end justify-between border-b border-gray-100 pb-6">
              <div>
                <h2 className="text-3xl font-extrabold tracking-tight">Índice</h2>
                <div className="flex items-center gap-4 mt-1">
                  <div className="text-[10px] font-mono text-brand-primary flex items-center gap-1">
                    <Timer size={10} />
                    <span>TIEMPO TOTAL: {formatTime(totalTime)}</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setShowResetConfirm(true)}
                className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                title="Reiniciar progreso"
              >
                <RotateCcw size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {sortedCountries.map((c) => {
                const status = results[c.code];
                const isCollected = status === 'collected';
                const isFailed = status === 'failed';
                
                return (
                  <div 
                    key={c.code}
                    className="group relative flex flex-col gap-2"
                  >
                    <div className={`
                      aspect-[3/2] rounded-xl overflow-hidden shadow-sm transition-all duration-500
                      ${isCollected ? 'border-2 border-green-500 ring-4 ring-green-50' : 'grayscale-flag border-2 border-transparent opacity-40'}
                    `}>
                      <img 
                        src={`https://flagcdn.com/w320/${c.code}.png`} 
                        alt={c.name}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                    <div className="flex items-center justify-between px-1">
                      <span className={`text-[10px] font-bold truncate ${isCollected ? 'text-gray-900' : 'text-gray-400'}`}>
                        {isCollected ? c.name : '???'}
                      </span>
                      <span className={`w-2 h-2 rounded-full ${isCollected ? 'bg-green-500' : isFailed ? 'bg-red-400' : 'bg-gray-200'}`} />
                    </div>
                    
                    <div className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                      <div className={`px-2 py-0.5 rounded text-[8px] font-bold uppercase ${DIFFICULTY_COLORS[c.difficulty]}`}>
                        {DIFFICULTY_LABELS[c.difficulty]}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {Object.keys(results).length === 0 && (
              <div className="py-20 text-center space-y-4">
                <BookOpen size={48} className="mx-auto text-gray-200" />
                <p className="text-gray-400 text-sm font-medium">Aún no has descubierto ninguna bandera.</p>
                <button 
                  onClick={() => setView('playing')}
                  className="bg-brand-dark text-white px-6 py-2 rounded-full text-xs font-bold uppercase tracking-widest"
                >
                  Empezar a Jugar
                </button>
              </div>
            )}

            <div className="mt-20 pt-10 border-t border-red-100">
              <div className="bg-red-50 rounded-3xl p-8 flex flex-col md:flex-row items-center justify-between gap-6">
                <div>
                  <h3 className="text-red-900 font-bold text-lg">Zona de Peligro</h3>
                  <p className="text-red-600/70 text-sm">Borrarás todas las banderas coleccionadas y el tiempo total. Esta acción no se puede deshacer.</p>
                </div>
                <button 
                  onClick={() => setShowResetConfirm(true)}
                  className="bg-red-500 text-white px-8 py-4 rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-red-600 transition-colors shadow-lg shadow-red-200"
                >
                  Reiniciar todo desde cero
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-2xl space-y-8 animate-in fade-in duration-500">
            <div className="text-center space-y-2">
              <h2 className="text-4xl font-extrabold italic font-display">Clasificación Mundial</h2>
              <p className="text-sm text-gray-500">Los 100 mejores exploradores de banderas</p>
            </div>

            <div className="flex p-1 bg-gray-100 rounded-2xl w-fit mx-auto">
              <button 
                onClick={() => setLeaderboardMode('normal')}
                className={`px-6 py-2 rounded-[0.85rem] text-xs font-bold uppercase tracking-widest transition-all ${leaderboardMode === 'normal' ? 'bg-white text-brand-dark shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
              >
                Normal
              </button>
              <button 
                onClick={() => setLeaderboardMode('timeAttack')}
                className={`px-6 py-2 rounded-[0.85rem] text-xs font-bold uppercase tracking-widest transition-all ${leaderboardMode === 'timeAttack' ? 'bg-white text-brand-dark shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
              >
                Contrarreloj
              </button>
            </div>

            <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100">
              {user && (
                <div className="bg-brand-dark p-4 flex items-center justify-between text-white border-b border-white/10">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-brand-primary flex items-center justify-center font-bold text-xs">
                      TU
                    </div>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest">{user.displayName}</p>
                      <p className="text-[10px] opacity-70">
                        {leaderboardMode === 'normal' 
                          ? `Aciertos: ${Object.values(results).filter(v => v === 'collected').length} | ${formatTime(totalTime)}` 
                          : `Récord 5 min: ${bestTimeAttackScore} banderas`}
                      </p>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setView('playing'); setMode(leaderboardMode); if(leaderboardMode === 'timeAttack') setTimeAttackStatus('idle'); }}
                    className="flex items-center gap-2 bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-colors"
                  >
                    <RotateCcw size={12} />
                    Nuevo Intento
                  </button>
                </div>
              )}
              <div className="divide-y divide-gray-50">
                {leaderboard.length > 0 ? (
                  leaderboard.filter(e => leaderboardMode === 'normal' ? true : (e.timeAttackScore && e.timeAttackScore > 0)).map((entry, index) => (
                    <div 
                      key={entry.userId} 
                      className={`flex items-center gap-4 p-4 transition-colors ${entry.userId === user?.uid ? 'bg-orange-50' : 'hover:bg-gray-50'}`}
                    >
                      <div className="w-8 text-center font-display text-xl font-black italic text-gray-300">
                        {index + 1}
                      </div>
                      <img src={entry.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${entry.userId}`} alt="" className="w-10 h-10 rounded-full bg-gray-100" />
                      <div className="flex-1">
                        <p className="font-bold text-sm leading-none flex items-center gap-2">
                          {entry.displayName}
                          {entry.userId === user?.uid && <span className="bg-brand-primary text-white text-[8px] px-1.5 py-0.5 rounded-full uppercase font-bold tracking-widest">Tú</span>}
                        </p>
                        <p className="text-[10px] font-mono text-gray-400 mt-1">ID: {entry.userId.slice(0, 8)}</p>
                      </div>
                      <div className="text-right">
                        <div className="flex items-center justify-end gap-1 text-brand-primary font-black">
                          <Award size={14} />
                          <span>{leaderboardMode === 'normal' ? entry.flagsCount : entry.timeAttackScore || 0}</span>
                        </div>
                        {leaderboardMode === 'normal' ? (
                          <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-gray-400">
                            <Timer size={10} />
                            <span>{formatTime(entry.totalTime)}</span>
                          </div>
                        ) : (
                          <div className="text-[8px] font-bold text-gray-300 uppercase tracking-tighter">Banderas / 5 min</div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-20 text-center text-gray-400 space-y-4">
                    <p className="text-sm">Aún no hay puntuaciones registradas.</p>
                    {!user && (
                      <button 
                        onClick={loginWithGoogle}
                        className="bg-brand-dark text-white px-6 py-2 rounded-full text-xs font-bold uppercase tracking-widest"
                      >
                        Entrar para Participar
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {!user && leaderboard.length > 0 && (
              <div className="glass-panel p-6 rounded-2xl text-center space-y-4">
                <p className="text-sm font-medium text-gray-600">¿Quieres aparecer en la lista?</p>
                <button 
                  onClick={loginWithGoogle}
                  className="bg-brand-dark text-white px-8 py-3 rounded-2xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 mx-auto hover:bg-brand-primary transition-colors"
                >
                  <LogIn size={16} />
                  Entrar con Google
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Reset Confirmation Modal */}
      <AnimatePresence>
        {showResetConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-brand-dark/40 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl space-y-6 text-center"
            >
              <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mx-auto">
                <RotateCcw size={32} />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold text-gray-900 Italics">¿Reiniciar progreso?</h3>
                <p className="text-sm text-gray-500 leading-relaxed">
                  Perderás todas las banderas que has conseguido y tu tiempo volverá a cero.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={confirmReset}
                  className="w-full bg-red-500 text-white py-4 rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-red-600 transition-colors shadow-lg shadow-red-200"
                >
                  Sí, reiniciar todo
                </button>
                <button 
                  onClick={() => setShowResetConfirm(false)}
                  className="w-full bg-gray-100 text-gray-600 py-4 rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-gray-200 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer bar for technical details feel */}
      <footer className="p-4 border-t border-gray-100 flex items-center justify-between text-[10px] font-mono font-medium text-gray-400 uppercase tracking-widest overflow-hidden">
        <div className="flex gap-4">
          <span>LAT: 0.0000</span>
          <span>LNG: 0.0000</span>
          <span>POOL_STATUS: {pendingPool.length} REMAINING</span>
        </div>
        <div className="flex items-center gap-1">
          <Info size={10} />
          <span>Manual Guía de Exploración</span>
        </div>
      </footer>
    </div>
  );
}
