"""Who may see and change what: one function, computed from accounts.

Every router and service resolves access through this module. The rule has a
single root, ``account_role(user, account)``:

- ``owner`` when the account is the user's (``account.user_id``);
- ``admin``, ``editor`` or ``viewer`` from the user's ``account_shares`` row;
- ``tag_viewer`` from a Household tag share (STU-233): the account's owner U
  shared their Household system tag with the user and put that tag on the
  account. Kept apart from ``viewer`` so its provenance is known; it ranks
  below it;
- ``none`` otherwise.

When several apply, the highest wins (``ROLE_RANK``). ``_shared_role`` is the
one place a role other than the owner's comes from. Nothing outside this
module should compare ``user_id`` columns to decide access to an account.

**Tag-share invariant.** A tag share from U only ever reaches records owned by
U on accounts owned by U: rules (b2) and (c) below, applied everywhere a
record is read (``readable_criterion`` with ``household_grants``, and
``can_read_record``). Records anyone else created on U's accounts are never
visible through it, and tags anyone but U applied grant nothing. A tag share
never grants a write, nor ``can_delete``.

Records that touch accounts (transactions and recurring entries) follow from it:

- **Read:** any one of
  (a) the caller created the record;
  (b) the caller holds a direct role (``owner``, ``admin``, ``editor`` or
  ``viewer``, never ``tag_viewer``) on any account it touches;
  (b2) the caller holds ``tag_viewer`` from U on an account it touches, U owns
  the record and U owns every account it touches;
  (c) the caller holds U's Household tag share, U owns the record, U owns
  every account it touches (or it touches none), and it carries U's Household
  tag explicitly (a ``transaction_tags`` or ``budget_entry_tags`` row; tags it
  only gets from its accounts never count).
- **Write:** the caller holds an edit role (``owner``, ``admin`` or ``editor``)
  on every account the record touches, before and after the change, and the
  record's creator still holds one on every account it touches afterwards.
- **Account owner exemption:** the owner of every account a record touches may
  post, revert or delete it even when its creator has lost access, so a
  stranded record can always be resolved.
- **Unposted records:** the creator may always delete their own unposted record
  (and their own recurring entry), whatever their role now; so may an owner of
  any account it touches. Neither moves a balance.
- A record that touches no account (a recurring entry with no account) is the
  creator's alone for writing; besides its creator only rule (c) reads it.

``RecordAccess.permissions`` turns these into the flags every record response
carries; the write routes check the same flags.

Categories, allocations and wishlist items are never shared: only their owner
reaches them. Every account a record references must be one its owner and
the caller may change; see ``require_account``. Every other record it
references (category, allocation, recurring entry, and the ids in an
allocation's configuration) must belong to the caller and to the record's
owner: the same-owner rule, see ``require_owned_ref``.

With no shares, the creator and the owner of the accounts a record touches are
the same user, so all of this reduces to "your own records only".

Failures are 404, never 403: a 403 would confirm the id exists to someone with
no right to know that.
"""

from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.account_share import AccountShare
from app.models.budget_entry import BudgetEntry
from app.models.tag import Tag, account_tags, budget_entry_tags, transaction_tags
from app.models.tag_share import TagShare
from app.models.transaction import Transaction, TransactionType

OWNER = "owner"
ADMIN = "admin"
EDITOR = "editor"
VIEWER = "viewer"
TAG_VIEWER = "tag_viewer"
NONE = "none"

# Highest first: when a user holds several roles on an account, the highest wins.
ROLE_RANK = {OWNER: 5, ADMIN: 4, EDITOR: 3, VIEWER: 2, TAG_VIEWER: 1, NONE: 0}

# Roles held on the account itself or through a direct share.
DIRECT_ROLES = frozenset({OWNER, "admin", "editor", "viewer"})
# Roles that see the account (in lists, as ``{id, name}`` references, in
# projection scope): the direct ones plus ``tag_viewer``. Reading records
# through ``tag_viewer`` follows (b2), never (b).
VIEW_ROLES = DIRECT_ROLES | {TAG_VIEWER}
# Roles that may add, change or remove records on the account.
EDIT_ROLES = frozenset({OWNER, "admin", "editor"})
# Roles that may change the account's settings and routing.
MANAGE_ROLES = frozenset({OWNER, "admin"})
# Deleting or deactivating an account is its owner's alone.
OWNER_ROLES = frozenset({OWNER})

# A record's explicit tag links: (c) reads them, never the account's tags.
TAG_LINKS = {
    Transaction: (transaction_tags, "transaction_id"),
    BudgetEntry: (budget_entry_tags, "budget_entry_id"),
}

# The accounts each kind of record touches. Recurring entries have no
# transfer_from_account_id: their source is account_id.
TOUCHED_COLUMNS = {
    Transaction: ("account_id", "transfer_from_account_id", "transfer_to_account_id"),
    BudgetEntry: ("account_id", "transfer_to_account_id", "overflow_account_id"),
}
# Columns that count only on a transfer. A debit or credit touches its
# account_id alone: any transfer_* value it carries (a stale one left by an
# edit from a transfer, or one a client sent) names no account it moves money
# on, so it grants no one access to it.
TRANSFER_ONLY_COLUMNS = {
    Transaction: frozenset({"transfer_from_account_id", "transfer_to_account_id"}),
    BudgetEntry: frozenset(),
}


def _counts(record, column: str) -> bool:
    """Whether ``column`` names an account ``record`` touches."""
    if column not in TRANSFER_ONLY_COLUMNS[type(record)]:
        return True
    return record.transaction_type == TransactionType.TRANSFER


def _uid(user) -> Optional[int]:
    """A user's id, from a ``User`` or a bare id."""
    return getattr(user, "id", user)


def _highest(*roles: str) -> str:
    return max(roles, key=ROLE_RANK.__getitem__)


def _holds_household_share(uid, account) -> bool:
    """Whether the account's owner put their Household tag on it and shared it with ``uid``.

    Reads the account's ``tag_links`` and each tag's ``shares`` (loaded with it).
    Only the owner's own system tag counts: a tag anyone else put on the
    account grants nothing.
    """
    for tag in account.tag_links:
        if (tag.is_system and tag.user_id == account.user_id
                and any(share.user_id == uid for share in tag.shares)):
            return True
    return False


def _shared_role(uid, account) -> str:
    """The role ``uid`` holds on ``account`` through a share, or ``none``.

    An account share's role (``admin``, ``editor`` or ``viewer``) outranks
    ``tag_viewer``, so it wins when the user holds both.
    """
    for share in account.shares:
        if share.user_id == uid:
            return share.role
    if _holds_household_share(uid, account):
        return TAG_VIEWER
    return NONE


def account_role(user, account) -> str:
    """The caller's role on ``account``: ``owner``, ``admin``, ``editor``, ``viewer``,
    ``tag_viewer`` or ``none``."""
    if user is None or account is None:
        return NONE
    uid = _uid(user)
    if account.user_id == uid:
        return OWNER
    return _highest(NONE, _shared_role(uid, account))


def role_map(db: Session, user) -> Dict[int, str]:
    """``{account id: role}`` for every account the caller holds a role on.

    The bulk form of ``account_role``, by the same rules, in two queries: an
    account missing from the map is ``none``.
    """
    uid = _uid(user)
    roles: Dict[int, str] = {}
    for account_id, role in db.query(AccountShare.account_id, AccountShare.role).filter(
            AccountShare.user_id == uid):
        roles[account_id] = _highest(roles.get(account_id, NONE), role)
    for (account_id,) in db.query(Account.id).filter(Account.id.in_(_tag_viewer_ids(uid))):
        roles.setdefault(account_id, TAG_VIEWER)
    for (account_id,) in db.query(Account.id).filter(Account.user_id == uid):
        roles[account_id] = OWNER
    return roles


def tag_shared_account_ids():
    """Select: the accounts whose owner put their Household tag on them and shared
    it with anyone (the accounts some user sees as ``tag_viewer``)."""
    return (select(account_tags.c.account_id)
            .join(Tag, Tag.id == account_tags.c.tag_id)
            .join(TagShare, TagShare.tag_id == Tag.id)
            .join(Account, Account.id == account_tags.c.account_id)
            .where(Tag.is_system.is_(True), Tag.user_id == Account.user_id))


def _tag_viewer_ids(uid):
    """Select: the accounts whose owner put their Household tag on them and shared it with ``uid``."""
    return tag_shared_account_ids().where(TagShare.user_id == uid)


def can_view_account(user, account) -> bool:
    """Whether the caller sees the account at all (any role, ``tag_viewer`` included)."""
    return account_role(user, account) in VIEW_ROLES


def can_edit_account(user, account) -> bool:
    return account_role(user, account) in EDIT_ROLES


def _held_criterion(user, roles=DIRECT_ROLES):
    """Criterion: the caller holds one of ``roles`` on the account (owner or share)."""
    uid = _uid(user)
    shared = [r for r in roles if r != OWNER]
    criteria = []
    if OWNER in roles:
        criteria.append(Account.user_id == uid)
    shared = [r for r in shared if r != TAG_VIEWER]
    if shared:
        criteria.append(Account.id.in_(
            select(AccountShare.account_id).where(
                AccountShare.user_id == uid, AccountShare.role.in_(shared))))
    if TAG_VIEWER in roles:
        criteria.append(Account.id.in_(_tag_viewer_ids(uid)))
    return or_(*criteria)


def viewable_accounts(db: Session, user, *, active_only: bool = False, roles=DIRECT_ROLES):
    """Query for the accounts the caller holds one of ``roles`` on (by default a
    direct role: their own and shared ones; ``VIEW_ROLES`` adds ``tag_viewer``)."""
    query = db.query(Account).filter(_held_criterion(user, roles))
    if active_only:
        query = query.filter(Account.is_active.is_(True))
    return query


def viewable_account_ids(db: Session, user, *, active_only: bool = False,
                         roles=DIRECT_ROLES) -> Set[int]:
    query = db.query(Account.id).filter(_held_criterion(user, roles))
    if active_only:
        query = query.filter(Account.is_active.is_(True))
    return {row[0] for row in query.all()}


def editable_account_ids(db: Session, user) -> Set[int]:
    """The accounts the caller may add, change or remove records on."""
    return {row[0] for row in db.query(Account.id).filter(_held_criterion(user, EDIT_ROLES))}


def record_account_ids(record) -> Tuple[int, ...]:
    """The distinct accounts a transaction or recurring entry touches."""
    columns = TOUCHED_COLUMNS[type(record)]
    ids = []
    for column in columns:
        if not _counts(record, column):
            continue
        value = getattr(record, column)
        if value is not None and value not in ids:
            ids.append(value)
    return tuple(ids)


def touches_accounts(model, account_ids: Iterable[int]):
    """Criterion: the record touches any of ``account_ids``."""
    ids = list(account_ids)
    criteria = []
    for column in TOUCHED_COLUMNS[model]:
        criterion = getattr(model, column).in_(ids)
        if column in TRANSFER_ONLY_COLUMNS[model]:
            criterion = and_(model.transaction_type == TransactionType.TRANSFER, criterion)
        criteria.append(criterion)
    return or_(*criteria)


@dataclass(frozen=True)
class HouseholdGrant:
    """A Household tag share the caller holds: what rules (b2) and (c) need."""

    sharer_id: int
    tag_id: int
    owned_ids: FrozenSet[int]   # every account the sharer owns
    tagged_ids: FrozenSet[int]  # the sharer's accounts carrying the tag (``tag_viewer``)


def household_grants(db: Session, user) -> List[HouseholdGrant]:
    """The Household tag shares the caller holds, one per sharer (none: ``[]``)."""
    uid = _uid(user)
    shares = (db.query(Tag.id, Tag.user_id).join(TagShare, TagShare.tag_id == Tag.id)
              .filter(TagShare.user_id == uid, Tag.is_system.is_(True), Tag.user_id != uid)
              .order_by(Tag.user_id).all())
    grants = []
    for tag_id, sharer_id in shares:
        owned = frozenset(row[0] for row in db.query(Account.id).filter(
            Account.user_id == sharer_id))
        tagged = frozenset(row[0] for row in db.query(account_tags.c.account_id).filter(
            account_tags.c.tag_id == tag_id, account_tags.c.account_id.in_(owned)))
        grants.append(HouseholdGrant(sharer_id, tag_id, owned, tagged))
    return grants


def _counted(model, column: str):
    """Criterion: ``column`` names an account the record touches (``_counts``)."""
    criterion = getattr(model, column).isnot(None)
    if column in TRANSFER_ONLY_COLUMNS[model]:
        criterion = and_(model.transaction_type == TransactionType.TRANSFER, criterion)
    return criterion


def touches_only(model, account_ids: Iterable[int]):
    """Criterion: every account the record touches is one of ``account_ids`` (or it touches none)."""
    ids = list(account_ids)
    return and_(*(or_(~_counted(model, c), getattr(model, c).in_(ids))
                  for c in TOUCHED_COLUMNS[model]))


def touches_none(model, account_ids: Iterable[int]):
    """Criterion: the record touches none of ``account_ids`` (null columns count for nothing)."""
    ids = list(account_ids)
    return and_(*(or_(~_counted(model, c), ~getattr(model, c).in_(ids))
                  for c in TOUCHED_COLUMNS[model]))


def own_household_grant(db: Session, user) -> Optional[HouseholdGrant]:
    """The caller's own Household tag in the shape of a grant (their own Household view)."""
    uid = _uid(user)
    tag_id = db.query(Tag.id).filter(Tag.user_id == uid, Tag.is_system.is_(True)).scalar()
    if tag_id is None:
        return None
    owned = frozenset(row[0] for row in db.query(Account.id).filter(Account.user_id == uid))
    tagged = frozenset(row[0] for row in db.query(account_tags.c.account_id).filter(
        account_tags.c.tag_id == tag_id, account_tags.c.account_id.in_(owned)))
    return HouseholdGrant(uid, tag_id, owned, tagged)


def explicit_tag_criterion(model, tag_id: int):
    """Criterion: the record carries ``tag_id`` as an explicit tag."""
    link, column = TAG_LINKS[model]
    return exists().where(link.c[column] == model.id, link.c.tag_id == tag_id)


def household_explicit_criterion(model, grant: HouseholdGrant):
    """Criterion: rule (c) for ``grant``: the sharer's record, on the sharer's
    accounts only (or none), carrying the sharer's Household tag explicitly."""
    return and_(model.user_id == grant.sharer_id, touches_only(model, grant.owned_ids),
                explicit_tag_criterion(model, grant.tag_id))


def household_criterion(model, grant: HouseholdGrant):
    """Criterion: rule (b2) or (c) for ``grant`` (the tag-share invariant)."""
    return and_(model.user_id == grant.sharer_id, touches_only(model, grant.owned_ids),
                or_(touches_accounts(model, grant.tagged_ids),
                    explicit_tag_criterion(model, grant.tag_id)))


def readable_criterion(model, user, scope_ids: Iterable[int],
                       grants: Iterable[HouseholdGrant] = ()):
    """Criterion for the transactions or recurring entries the caller may read.

    ``scope_ids`` are accounts the caller holds a direct role on (see
    ``viewable_account_ids``): a record is readable when the caller created it
    or it touches one of them, rules (a) and (b). ``grants``
    (``household_grants``) add rules (b2) and (c); with none (no tag shares)
    the criterion is exactly (a) or (b).
    """
    return or_(model.user_id == _uid(user), touches_accounts(model, scope_ids),
               *(household_criterion(model, g) for g in grants))


def _accounts(db: Session, ids: Iterable[int]) -> dict:
    ids = list(ids)
    if not ids:
        return {}
    return {a.id: a for a in db.query(Account).filter(Account.id.in_(ids)).all()}


def has_explicit_tag(db: Session, record, tag_id: int) -> bool:
    link, column = TAG_LINKS[type(record)]
    return db.query(exists().where(link.c[column] == record.id,
                                   link.c.tag_id == tag_id)).scalar()


def household_reads(db: Session, grant: HouseholdGrant, record, *, explicit=None) -> Optional[str]:
    """Which of rules (b2) and (c) ``grant`` gives on ``record``: "b2", "c" or None.

    (c) is reported when it holds, since it also decides the description and
    tags; ``explicit`` is a precomputed "carries the tag explicitly".
    """
    if record.user_id != grant.sharer_id:
        return None
    ids = record_account_ids(record)
    if any(i not in grant.owned_ids for i in ids):
        return None
    if explicit is None:
        explicit = has_explicit_tag(db, record, grant.tag_id)
    if explicit:
        return "c"
    if any(i in grant.tagged_ids for i in ids):
        return "b2"
    return None


def can_read_record(db: Session, user, record) -> bool:
    """Read rule for a transaction or recurring entry (see the module docstring)."""
    if record.user_id == _uid(user):
        return True
    accounts = _accounts(db, record_account_ids(record))
    if any(account_role(user, a) in DIRECT_ROLES for a in accounts.values()):
        return True
    return any(household_reads(db, g, record) for g in household_grants(db, user)
               if g.sharer_id == record.user_id)


def can_write_record(db: Session, user, record) -> bool:
    """Write rule for a transaction or recurring entry, on its current accounts.

    The caller needs an edit role on every account the record touches; a record
    touching no account is its creator's alone. Accounts the record moves to are
    checked separately (``require_account``), as is the creator keeping access.
    """
    ids = record_account_ids(record)
    if not ids:
        return record.user_id == _uid(user)
    accounts = _accounts(db, ids)
    if len(accounts) != len(ids):
        return False
    return all(account_role(user, a) in EDIT_ROLES for a in accounts.values())


class RecordAccess:
    """Per-request access for one caller over many records, without a query per record.

    Accounts are loaded once (with their shares) and roles are computed by the
    same rules as ``account_role``, for the caller and for each record's
    creator. ``permissions`` gives the flags every record response carries.
    """

    def __init__(self, db: Session, user):
        self.db = db
        self.uid = _uid(user)
        self._accounts: Dict[int, Optional[Account]] = {}
        self._grants: Optional[Dict[int, HouseholdGrant]] = None
        self._explicit: Dict[Tuple[type, int], bool] = {}

    @property
    def grants(self) -> Dict[int, HouseholdGrant]:
        """The caller's Household tag shares, by sharer (loaded once)."""
        if self._grants is None:
            self._grants = {g.sharer_id: g for g in household_grants(self.db, self.uid)}
        return self._grants

    def load_explicit(self, records: Iterable) -> None:
        """Preload which records carry their owner's shared Household tag explicitly."""
        if not self.grants:
            return
        by_model: Dict[type, list] = {}
        for record in records:
            grant = self.grants.get(record.user_id)
            if grant is not None and (type(record), record.id) not in self._explicit:
                by_model.setdefault(type(record), []).append(record)
        for model, group in by_model.items():
            link, column = TAG_LINKS[model]
            tags = {g.tag_id for g in self.grants.values()}
            found = {(rid, tid) for rid, tid in self.db.query(link.c[column], link.c.tag_id).filter(
                link.c[column].in_([r.id for r in group]), link.c.tag_id.in_(tags))}
            for record in group:
                self._explicit[(model, record.id)] = (
                    (record.id, self.grants[record.user_id].tag_id) in found)

    def household(self, record) -> Optional[str]:
        """Rule (b2) or (c) on ``record`` through the caller's tag shares: "b2", "c" or None."""
        grant = self.grants.get(record.user_id) if record.user_id != self.uid else None
        if grant is None:
            return None
        key = (type(record), record.id)
        if key not in self._explicit:
            self.load_explicit([record])
        return household_reads(self.db, grant, record, explicit=self._explicit[key])

    def readable(self, record) -> bool:
        """The read rule, from loaded accounts (``can_read_record``)."""
        if record.user_id == self.uid:
            return True
        ids = record_account_ids(record)
        self.load(ids)
        if any(self.role(i) in DIRECT_ROLES for i in ids):
            return True
        return self.household(record) is not None

    def load(self, ids: Iterable[int]) -> None:
        missing = [i for i in set(ids) if i is not None and i not in self._accounts]
        if missing:
            for account in self.db.query(Account).filter(Account.id.in_(missing)).all():
                self._accounts[account.id] = account
            for i in missing:
                self._accounts.setdefault(i, None)

    def account(self, account_id: Optional[int]) -> Optional[Account]:
        if account_id is None:
            return None
        self.load([account_id])
        return self._accounts[account_id]

    def role(self, account_id: Optional[int], user=None) -> str:
        """``user``'s role (default the caller) on the account."""
        return account_role(self.uid if user is None else user, self.account(account_id))

    def facts(self, record) -> dict:
        """The access facts every rule about ``record`` is built from."""
        ids = record_account_ids(record)
        self.load(ids)
        is_creator = record.user_id == self.uid
        mine = [self.role(i) for i in ids]
        theirs = [self.role(i, record.user_id) for i in ids]
        return {
            "ids": ids,
            "is_creator": is_creator,
            # Every touched account is one the caller sees (``tag_viewer``
            # included). An accountless record: its creator only.
            "view_all": all(r in VIEW_ROLES for r in mine) if ids else is_creator,
            "edit_all": all(r in EDIT_ROLES for r in mine) if ids else is_creator,
            "creator_edits": all(r in EDIT_ROLES for r in theirs),
            "owns_all": bool(ids) and all(r == OWNER for r in mine),
            "owns_any": any(r == OWNER for r in mine),
        }

    def permissions(self, record) -> dict:
        """``can_edit``, ``can_delete``, ``can_post``, ``can_revert`` and ``can_tag``.

        - edit (and tag): the write rule, an edit role on every touched account
          for the caller and for the creator;
        - post, revert and delete also under the account owner exemption: the
          owner of every touched account may resolve a record whose creator lost
          access;
        - an unposted transaction may always be deleted by its creator and by an
          owner of any account it touches; so may a recurring entry (it moves no
          balance either);
        - a recurring entry is "posted" by materialising it (``can_post``), which
          needs the write rule and an account to post to; it is never reverted.

        ``tag_viewer`` is in no edit role and owns nothing, so a record read
        through a tag share gets every flag false.
        """
        f = self.facts(record)
        can_edit = f["edit_all"] and f["creator_edits"]
        resolve = f["edit_all"] and (f["creator_edits"] or f["owns_all"])
        unposted_delete = f["is_creator"] or f["owns_any"]
        if isinstance(record, Transaction):
            posted = bool(record.is_posted)
            return {
                "can_edit": can_edit,
                "can_delete": resolve or (not posted and unposted_delete),
                "can_post": resolve and not posted,
                "can_revert": resolve and posted,
                "can_tag": can_edit,
            }
        return {
            "can_edit": can_edit,
            "can_delete": resolve or unposted_delete,
            "can_post": can_edit and record.account_id is not None,
            "can_revert": False,
            "can_tag": can_edit,
        }


def record_permissions(db: Session, user, record) -> dict:
    return RecordAccess(db, user).permissions(record)


def get_account_or_404(db: Session, user, account_id: int, detail: str = "Account not found",
                       *, roles=DIRECT_ROLES) -> Account:
    """The account, 404ing unless the caller holds one of ``roles`` on it."""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account or account_role(user, account) not in roles:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return account


def require_account(db: Session, user, account_id: Optional[int], detail: str,
                    *, owner=None) -> Optional[Account]:
    """The account a record will touch, 404ing unless both may use it.

    The caller needs an edit role on it, and so does the record's owner
    (``owner``, default the caller): a record never lands on an account its
    owner could not change. A None id is skipped.
    """
    if account_id is None:
        return None
    account = db.query(Account).filter(Account.id == account_id).first()
    if (not account or not can_edit_account(user, account)
            or (owner is not None and not can_edit_account(owner, account))):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return account


def get_record_or_404(db: Session, model, record_id: int, user, detail: str = "Not found",
                      *, write: bool = False, creator: bool = False):
    """A transaction or recurring entry the caller may read (or write, with ``write``).

    With ``creator`` the caller must also have created it: for changes to the
    creator's own fields (a receipt), which the owner of the accounts the record
    touches may not make on someone else's record.
    """
    record = db.query(model).filter(model.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    allowed = can_write_record(db, user, record) if write else can_read_record(db, user, record)
    if creator and record.user_id != _uid(user):
        allowed = False
    if not allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def get_owned_or_404(db: Session, model, record_id: int, user, detail: str = "Not found"):
    """A record that is never shared (category, allocation, wishlist item): owner only."""
    record = db.query(model).filter(model.id == record_id).first()
    if not record or record.user_id != _uid(user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def require_owned_ref(db: Session, model, ref_id: Optional[int], detail: str, *owners):
    """A never-shared record another record references, 404ing unless it is every owner's.

    The same-owner rule: a category, allocation or recurring entry referenced by
    a record must belong to the caller and to the referencing record's owner
    (pass both; None is skipped). A None id is skipped.
    """
    if ref_id is None:
        return None
    record = db.query(model).filter(model.id == ref_id).first()
    if not record or any(record.user_id != _uid(o) for o in owners if o is not None):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def owned_criterion(model, user):
    """Criterion for the never-shared records the caller owns."""
    return model.user_id == _uid(user)

