---- MODULE InternalCapability ----
\* Models the warm-engine internal capability bearer in server/index.ts:
\* sessionBearer, mintInternalCapability, revokeInternalCapabilityGeneration,
\* authorizedInternalCapability, and the post-authorize recheck in
\* readInternalBody / requireActiveInternalCapability.
\*
\* Property (plain words): a tool call that left the engine during turn G1
\* must not commit as turn G2's work when the same bearer is reminted.
\*
\* RotateBearerOnGeneration = FALSE mirrors the current code (stable bearer).
\* RotateBearerOnGeneration = TRUE is the repair: revoke also retires the
\* session credential so the next mint issues a new bearer.

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS MaxReqs, MaxGens, RotateBearerOnGeneration

ASSUME MaxReqs \in Nat /\ MaxReqs >= 1
ASSUME MaxGens \in Nat /\ MaxGens >= 2
ASSUME RotateBearerOnGeneration \in BOOLEAN

VARIABLES
  activeGen,
  nextGenId,
  recordGen,
  sessionHeld,
  sessionToken,
  nextTokenId,
  req,
  nextReqId,
  genClock

vars == <<activeGen, nextGenId, recordGen, sessionHeld, sessionToken,
           nextTokenId, req, nextReqId, genClock>>

Phases == {"idle", "inflight", "authorized", "committed", "rejected"}

TypeOK ==
  /\ activeGen \in Nat
  /\ nextGenId \in Nat \ {0}
  /\ recordGen \in Nat
  /\ sessionHeld \in BOOLEAN
  /\ sessionToken \in Nat
  /\ nextTokenId \in Nat \ {0}
  /\ nextReqId \in 1..(MaxReqs + 1)
  /\ genClock \in 0..MaxGens
  /\ req \in [1..MaxReqs -> [phase: Phases, produceGen: Nat, authGen: Nat, bearer: Nat]]

Init ==
  /\ activeGen = 0
  /\ nextGenId = 1
  /\ recordGen = 0
  /\ sessionHeld = FALSE
  /\ sessionToken = 0
  /\ nextTokenId = 1
  /\ nextReqId = 1
  /\ genClock = 0
  /\ req = [i \in 1..MaxReqs |->
              [phase |-> "idle", produceGen |-> 0, authGen |-> 0, bearer |-> 0]]

\* beginInternalCapabilityGeneration: revoke previous record, set active gen.
BeginGeneration ==
  /\ genClock < MaxGens
  /\ IF RotateBearerOnGeneration
       THEN /\ sessionHeld' = FALSE
            /\ sessionToken' = 0
            /\ UNCHANGED nextTokenId
       ELSE UNCHANGED <<sessionHeld, sessionToken, nextTokenId>>
  /\ recordGen' = 0
  /\ activeGen' = nextGenId
  /\ nextGenId' = nextGenId + 1
  /\ genClock' = genClock + 1
  /\ UNCHANGED <<req, nextReqId>>

\* mintInternalCapability with perTurn = FALSE (agents / connectors / hooks).
Mint ==
  /\ activeGen # 0
  /\ recordGen # activeGen
  /\ IF sessionHeld
       THEN UNCHANGED <<sessionHeld, sessionToken, nextTokenId>>
       ELSE /\ sessionHeld' = TRUE
            /\ sessionToken' = nextTokenId
            /\ nextTokenId' = nextTokenId + 1
  /\ recordGen' = activeGen
  /\ UNCHANGED <<activeGen, nextGenId, req, nextReqId, genClock>>

\* Engine issues an internal HTTP call while its turn is active.
Produce ==
  /\ activeGen # 0
  /\ recordGen = activeGen
  /\ sessionHeld
  /\ nextReqId <= MaxReqs
  /\ req' = [req EXCEPT ![nextReqId] =
               [phase |-> "inflight",
                produceGen |-> activeGen,
                authGen |-> 0,
                bearer |-> sessionToken]]
  /\ nextReqId' = nextReqId + 1
  /\ UNCHANGED <<activeGen, nextGenId, recordGen, sessionHeld, sessionToken,
                 nextTokenId, genClock>>

\* authorizedInternalCapability: lookup by bearer, honour only an active record.
Authorize(i) ==
  /\ req[i].phase = "inflight"
  /\ sessionHeld
  /\ req[i].bearer = sessionToken
  /\ recordGen # 0
  /\ recordGen = activeGen
  /\ req' = [req EXCEPT ![i] =
               [@ EXCEPT !.phase = "authorized", !.authGen = recordGen]]
  /\ UNCHANGED <<activeGen, nextGenId, recordGen, sessionHeld, sessionToken,
                 nextTokenId, nextReqId, genClock>>

AuthorizeReject(i) ==
  /\ req[i].phase = "inflight"
  /\ \/ ~sessionHeld
     \/ req[i].bearer # sessionToken
     \/ recordGen = 0
     \/ recordGen # activeGen
  /\ req' = [req EXCEPT ![i] = [@ EXCEPT !.phase = "rejected"]]
  /\ UNCHANGED <<activeGen, nextGenId, recordGen, sessionHeld, sessionToken,
                 nextTokenId, nextReqId, genClock>>

\* readInternalBody / requireActiveInternalCapability recheck the captured record.
Commit(i) ==
  /\ req[i].phase = "authorized"
  /\ req[i].authGen = activeGen
  /\ recordGen = activeGen
  /\ req' = [req EXCEPT ![i] = [@ EXCEPT !.phase = "committed"]]
  /\ UNCHANGED <<activeGen, nextGenId, recordGen, sessionHeld, sessionToken,
                 nextTokenId, nextReqId, genClock>>

CommitReject(i) ==
  /\ req[i].phase = "authorized"
  /\ \/ req[i].authGen # activeGen
     \/ recordGen # activeGen
  /\ req' = [req EXCEPT ![i] = [@ EXCEPT !.phase = "rejected"]]
  /\ UNCHANGED <<activeGen, nextGenId, recordGen, sessionHeld, sessionToken,
                 nextTokenId, nextReqId, genClock>>

IdleDone ==
  /\ genClock = MaxGens
  /\ \A i \in 1..MaxReqs: req[i].phase \in {"idle", "committed", "rejected"}
  /\ UNCHANGED vars

Next ==
  \/ BeginGeneration
  \/ Mint
  \/ Produce
  \/ \E i \in 1..MaxReqs: Authorize(i)
  \/ \E i \in 1..MaxReqs: AuthorizeReject(i)
  \/ \E i \in 1..MaxReqs: Commit(i)
  \/ \E i \in 1..MaxReqs: CommitReject(i)
  \/ IdleDone

Spec == Init /\ [][Next]_vars

\* Bytes produced under G1 never commit under G2's authority.
NoCrossGenerationCommit ==
  \A i \in 1..MaxReqs:
    req[i].phase = "committed" => req[i].produceGen = req[i].authGen

====
