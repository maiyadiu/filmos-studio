from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from film_production_core.api import create_app
from test_generation_production import acceptance_authority, authorization, preview


def v2_authority():
    legacy = acceptance_authority()
    old = legacy['bindings']
    bindings = {
        'schemaVersion': 2,
        'projectPolicy': {
            **old['projectPolicy'], 'schemaVersion': 2,
            'allowedConnections': [], 'defaultRoutes': {}, 'modelLocksByTask': {},
            'budgetGrantIdsByConnection': {}, 'externalProjectBindings': {},
        },
        'connections': [], 'catalogs': [], 'grants': [], 'ledgers': [],
    }
    for suffix, task in [('a', 'text_to_image'), ('b', 'text_to_video')]:
        cid = f'connection-{suffix}'
        for singular, plural in [('connection', 'connections'), ('catalog', 'catalogs'), ('grant', 'grants'), ('ledger', 'ledgers')]:
            item = {**deepcopy(old[singular]), 'connectionId': cid}
            if singular in ('grant', 'ledger'):
                item['grantId'] = f'grant-{suffix}'
                item['status'] = 'active'
            if singular == 'ledger':
                item['ledgerId'] = f'ledger-{suffix}'
            bindings[plural].append(item)
        route = {'engineId': old['connection']['engineId'], 'connectionId': cid}
        bindings['projectPolicy']['allowedConnections'].append(route)
        bindings['projectPolicy']['defaultRoutes'][task] = {**route, 'modelId': f'model-{suffix}'}
        bindings['projectPolicy']['modelLocksByTask'][task] = {**route, 'modelId': f'model-{suffix}'}
        bindings['projectPolicy']['budgetGrantIdsByConnection'][cid] = f'grant-{suffix}'
    return {**legacy, 'bindings': bindings}


def test_v2_save_read_restart_replay_and_restore_previous_settings(tmp_path):
    path = tmp_path / 'core.sqlite'
    client = TestClient(create_app(path))
    payload = v2_authority()
    response = client.post('/generation-production/project-authority', json=payload)
    assert response.status_code == 200, response.text
    stored = response.json()
    assert stored['bindings']['schemaVersion'] == 2
    assert 'connection' not in stored['bindings']
    assert stored['bindings']['projectPolicy'] == payload['bindings']['projectPolicy']
    assert len(stored['bindings']['ledgers']) == 2
    assert client.post('/generation-production/project-authority', json=payload).json() == stored
    restarted = TestClient(create_app(path))
    assert restarted.get('/generation-production/project-authority/' + payload['projectId']).json() == stored
    changed = deepcopy(payload)
    changed['projectName'] = 'FilmOS_Acceptance_Project'
    changed['bindings']['projectPolicy']['modelLocksByTask'] = {}
    assert client.post('/generation-production/project-authority', json=changed).status_code == 200
    assert client.post('/generation-production/project-authority', json=payload).json() == stored


@pytest.mark.parametrize('mutation', [
    lambda b: b['catalogs'][1].update(connectionId='connection-a'),
    lambda b: b['grants'][1].update(projectId='other-project'),
    lambda b: b['ledgers'][1].update(grantId='grant-a'),
    lambda b: b['grants'][1].update(connectionInstanceRef='other-instance'),
    lambda b: b['projectPolicy']['defaultRoutes']['text_to_video'].update(connectionId='missing'),
    lambda b: b['projectPolicy']['budgetGrantIdsByConnection'].update({'connection-b': 'grant-a'}),
    lambda b: b['grants'][1].update(maxTasks=0),
    lambda b: b['grants'][1]['maxTotalCost'].update(amountMicrounits='-1'),
    lambda b: b['grants'][1].update(status='revoked'),
    lambda b: b['projectPolicy']['defaultRoutes']['text_to_video'].update(connectionId=[]),
])
def test_v2_invalid_second_connection_has_zero_partial_writes(tmp_path, mutation):
    app = create_app(tmp_path / 'core.sqlite')
    client = TestClient(app)
    payload = v2_authority()
    mutation(payload['bindings'])
    response = client.post('/generation-production/project-authority', json=payload)
    assert response.status_code == 409, response.text
    with app.state.generation_production.database.connect() as conn:
        for table in ('generation_budget_grants', 'generation_budget_ledgers', 'generation_production_traces'):
            assert conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0


def test_v2_budget_preserves_usage_limits_and_connection_selection(tmp_path):
    app = create_app(tmp_path / 'core.sqlite')
    client = TestClient(app)
    payload = v2_authority()
    assert client.post('/generation-production/project-authority', json=payload).status_code == 200
    store = app.state.generation_production
    before = store.budget.snapshot('ledger-b')
    store.budget.reserve(reservation_id='already-reserved', ledger_id='ledger-b',
        generation_attempt_id='prior', route_content_hash='1' * 64, tasks=2, cost_microunits='0',
        idempotency_key='prior', expected_version=before['version'], expected_content_hash=before['content_hash'])
    changed = deepcopy(payload)
    changed['bindings']['grants'][1]['maxTasks'] = 12
    saved = client.post('/generation-production/project-authority', json=changed)
    assert saved.status_code == 200, saved.text
    ledgers = saved.json()['bindings']['ledgers']
    assert ledgers[0]['reservedTasks'] == 0
    assert ledgers[1]['reservedTasks'] == 2
    with store.database.connect() as conn:
        assert conn.execute("SELECT max_tasks FROM generation_budget_grants WHERE grant_id='grant-b'").fetchone()[0] == 12
    changed['bindings']['grants'][1]['maxTasks'] = 1
    assert client.post('/generation-production/project-authority', json=changed).status_code == 409
    # Use the second connection's actual ledger, never a first-entry fallback.
    stored = saved.json()
    shot = preview('attempt-v2', 'proposal-v2')
    shot['routeSnapshot']['connectionId'] = 'connection-b'
    assert client.post('/generation-production/previews', json=shot).status_code == 200
    legacy_view = {'bindings': {'ledger': ledgers[1], 'grant': stored['bindings']['grants'][1]}}
    command = authorization(shot, 'authorized-v2', legacy_view)
    wrong = deepcopy(command)
    wrong['budgetReservation']['ledgerId'] = 'ledger-a'
    assert client.post('/generation-production/authorizations', json=wrong).status_code == 409
    response = client.post('/generation-production/authorizations', json=command)
    assert response.status_code == 200, response.text


def test_v2_conflicting_existing_ledger_rolls_back_first_new_connection(tmp_path):
    app = create_app(tmp_path / 'core.sqlite')
    client = TestClient(app)
    payload = v2_authority()
    assert client.post('/generation-production/project-authority', json=payload).status_code == 200
    changed = deepcopy(payload)
    changed['bindings']['grants'][0]['grantId'] = 'new-grant'
    changed['bindings']['ledgers'][0].update(ledgerId='new-ledger', grantId='new-grant')
    changed['bindings']['projectPolicy']['budgetGrantIdsByConnection']['connection-a'] = 'new-grant'
    changed['bindings']['connections'][1]['connectionInstanceRef'] = 'rotated'
    changed['bindings']['grants'][1]['connectionInstanceRef'] = 'rotated'
    changed['bindings']['ledgers'][1]['connectionInstanceRef'] = 'rotated'
    assert client.post('/generation-production/project-authority', json=changed).status_code == 409
    with app.state.generation_production.database.connect() as conn:
        assert conn.execute("SELECT count(*) FROM generation_budget_grants WHERE grant_id='new-grant'").fetchone()[0] == 0
