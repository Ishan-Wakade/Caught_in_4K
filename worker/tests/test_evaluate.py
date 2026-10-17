from recyclone_worker.evaluate import evaluate, labeled_event


def ev(offset, bin_id, item=None, mode="recorded"):
    return {"clip_offset_s": offset, "bin_id": bin_id, "source": {"mode": mode},
            "item": {"catalog_item_id": item}}


def test_perfect_run():
    labels = [ev(5, "bin_t", "a"), ev(10, "bin_r", "b")]
    r = evaluate(labels, [ev(5.4, "bin_t", "a"), ev(9.8, "bin_r", "b")])
    assert (r["labeled"], r["predicted"], r["matched"], r["missed"], r["extra"], r["wrong_bin"]) == (2, 2, 2, 0, 0, 0)
    assert r["item_correct"] == 2 and r["assessable"] == 2


def test_missed_extra_and_wrong_bin():
    labels = [ev(5, "bin_t", "a"), ev(20, "bin_r", "b"), ev(40, "bin_c", "c")]
    preds = [ev(5.2, "bin_r", "a"),   # right moment, wrong bin
             ev(30, "bin_t", None)]   # nothing labeled near 30 s
    r = evaluate(labels, preds, tolerance_s=1.5)
    assert r["matched"] == 0 and r["wrong_bin"] == 1 and r["missed"] == 2 and r["extra"] == 1
    assert r["assessable"] == 1


def test_each_label_matched_once():
    labels = [ev(5, "bin_t", "a")]
    r = evaluate(labels, [ev(5.1, "bin_t", "a"), ev(5.3, "bin_t", "a")])
    assert r["matched"] == 1 and r["extra"] == 1


def test_wrong_item_counted():
    r = evaluate([ev(5, "bin_t", "a")], [ev(5, "bin_t", "b")])
    assert r["matched"] == 1 and r["item_correct"] == 0


def test_labeled_event_is_contract_valid():
    from datetime import UTC, datetime
    from recyclone_worker.events import validate_event
    e = labeled_event(row=3, clip_id="clip_demo_v1", camera_id="cam_patio_1", started_at=datetime(2026, 10, 17, tzinfo=UTC),
                      offset_s=12.5, bin_id="bin_patio_trash", catalog_item_id="item_shakeshack_cup", business_id=None)
    validate_event(e)
    assert e["source"] == {"camera_id": "cam_patio_1", "clip_id": "clip_demo_v1", "track_id": 3, "mode": "labeled"}
    assert e["item"]["confidence"] == 1.0 and e["destination_confidence"] == 1.0
    unknown = labeled_event(row=4, clip_id="c", camera_id="cam_patio_1", started_at=datetime(2026, 10, 17, tzinfo=UTC),
                            offset_s=1, bin_id="bin_patio_trash", catalog_item_id=None, business_id=None)
    validate_event(unknown)
    assert unknown["item"] == {"catalog_item_id": None, "label": None, "confidence": None, "candidates": []}


def test_bin_rule_right_even_with_wrong_brand():
    """Brand doesn't matter: a Shake Shack cup reported as a plain cup still gets the right bin rule."""
    dest = {"item_ss_cup": "recycling", "item_generic_cup": "recycling", "item_box": "compost"}
    labels = [ev(5, "bin_t", "item_ss_cup"), ev(10, "bin_t", "item_ss_cup")]
    preds = [ev(5, "bin_t", "item_generic_cup"), ev(10, "bin_t", "item_box")]
    r = evaluate(labels, preds, destinations=dest)
    assert r["item_correct"] == 0 and r["rule_correct"] == 1
