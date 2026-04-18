import json
import math
import sys
from typing import Dict, List, Tuple


def parse_tag_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return dedupe([str(v).strip() for v in value if str(v).strip()])
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return dedupe([str(v).strip() for v in parsed if str(v).strip()])
        except Exception:
            pass
        separators = ["\n", ",", "，", "、", "|", "/"]
        for sep in separators[1:]:
            text = text.replace(sep, separators[0])
        return dedupe([item.strip() for item in text.split(separators[0]) if item.strip()])
    return []


def dedupe(items: List[str]) -> List[str]:
    result = []
    seen = set()
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def normalize_scores(raw_scores: Dict[int, float]) -> Dict[str, float]:
    if not raw_scores:
        return {}
    values = list(raw_scores.values())
    min_value = min(values)
    max_value = max(values)
    result = {}
    for dish_id, score in raw_scores.items():
        if max_value == min_value:
            normalized = 0.0 if max_value == 0 else 1.0
        else:
            normalized = (score - min_value) / (max_value - min_value)
        result[str(dish_id)] = float(max(0.0, min(1.0, normalized)))
    return result


def build_vocab(dishes, history_items) -> Dict[str, int]:
    vocab = {}
    for source in list(dishes) + list(history_items):
        for tag in parse_tag_list(source.get("flavorTags")) + parse_tag_list(source.get("ingredientTags")):
            key = tag.lower()
            if key not in vocab:
                vocab[key] = len(vocab)
    return vocab


def vectorize(item, vocab: Dict[str, int]) -> List[float]:
    vector = [0.0] * len(vocab)
    for tag in parse_tag_list(item.get("flavorTags")) + parse_tag_list(item.get("ingredientTags")):
        key = tag.lower()
        if key in vocab:
            vector[vocab[key]] = 1.0
    return vector


def build_frequency_fallback(dishes, history_items) -> Dict[str, float]:
    tag_weights: Dict[str, float] = {}
    for item in history_items:
        recency_weight = max(1.0, 20.0 - float(item.get("orderIndex", 0) or 0))
        quantity_weight = max(1.0, float(item.get("quantity", 1) or 1))
        total_weight = recency_weight * quantity_weight
        tags = parse_tag_list(item.get("flavorTags")) + parse_tag_list(item.get("ingredientTags"))
        for tag in tags:
            key = tag.lower()
            tag_weights[key] = tag_weights.get(key, 0.0) + total_weight

    raw_scores: Dict[int, float] = {}
    for dish in dishes:
        dish_id = int(dish["id"])
        tags = parse_tag_list(dish.get("flavorTags")) + parse_tag_list(dish.get("ingredientTags"))
        if not tags:
            raw_scores[dish_id] = 0.0
            continue
        raw_scores[dish_id] = sum(tag_weights.get(tag.lower(), 0.0) for tag in tags) / len(tags)
    return normalize_scores(raw_scores)


def build_training_data(dishes, history_items, vocab):
    dish_pool = [dish for dish in dishes if vectorize(dish, vocab)]
    if not dish_pool:
        return [], [], []

    X, y, sample_weight = [], [], []

    for index, item in enumerate(history_items):
        positive_vector = vectorize(item, vocab)
        if not positive_vector:
            continue

        recency_weight = max(1.0, 20.0 - float(item.get("orderIndex", 0) or 0))
        quantity_weight = max(1.0, float(item.get("quantity", 1) or 1))
        positive_weight = recency_weight * quantity_weight

        X.append(positive_vector)
        y.append(1)
        sample_weight.append(positive_weight)

        negative_candidates = [dish for dish in dish_pool if int(dish["id"]) != int(item.get("dishId") or -1)]
        if not negative_candidates:
            continue

        start = index % len(negative_candidates)
        negative_count = min(3, len(negative_candidates))
        for offset in range(negative_count):
            negative_dish = negative_candidates[(start + offset) % len(negative_candidates)]
            negative_vector = vectorize(negative_dish, vocab)
            if not negative_vector:
                continue
            X.append(negative_vector)
            y.append(0)
            sample_weight.append(max(1.0, positive_weight * 0.6))

    return X, y, sample_weight


def sigmoid(z: float) -> float:
    if z >= 0:
        exp_neg = math.exp(-z)
        return 1.0 / (1.0 + exp_neg)
    exp_pos = math.exp(z)
    return exp_pos / (1.0 + exp_pos)


def build_logistic_fallback_scores(dishes, history_items, vocab):
    positive_tag_score = [0.0] * len(vocab)
    for item in history_items:
        recency_weight = max(1.0, 20.0 - float(item.get("orderIndex", 0) or 0))
        quantity_weight = max(1.0, float(item.get("quantity", 1) or 1))
        weight = recency_weight * quantity_weight
        vector = vectorize(item, vocab)
        for idx, value in enumerate(vector):
            positive_tag_score[idx] += value * weight

    raw_scores = {}
    for dish in dishes:
        vector = vectorize(dish, vocab)
        dot = sum(w * x for w, x in zip(positive_tag_score, vector))
        raw_scores[int(dish["id"])] = sigmoid(dot / max(1.0, sum(vector) or 1.0))
    return normalize_scores(raw_scores)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    dishes = payload.get("dishes") or []
    history_items = payload.get("historyItems") or []

    if not dishes:
        print(json.dumps({"mode": "empty_menu", "preferenceScores": {}}))
        return

    if not history_items:
        print(json.dumps({"mode": "cold_start", "preferenceScores": {str(dish["id"]): 0.0 for dish in dishes}}))
        return

    vocab = build_vocab(dishes, history_items)
    if not vocab:
        print(json.dumps({"mode": "tag_frequency_fallback", "preferenceScores": build_frequency_fallback(dishes, history_items)}))
        return

    X, y, sample_weight = build_training_data(dishes, history_items, vocab)
    if len(X) < 4 or len(set(y)) < 2:
        print(json.dumps({"mode": "tag_frequency_fallback", "preferenceScores": build_frequency_fallback(dishes, history_items)}))
        return

    try:
        import numpy as np
        from xgboost import XGBClassifier

        X_array = np.array(X, dtype=float)
        y_array = np.array(y, dtype=int)
        weight_array = np.array(sample_weight, dtype=float)

        model = XGBClassifier(
            n_estimators=80,
            max_depth=3,
            learning_rate=0.08,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="binary:logistic",
            eval_metric="logloss",
            reg_lambda=1.0,
            random_state=42,
        )
        model.fit(X_array, y_array, sample_weight=weight_array)

        predict_matrix = np.array([vectorize(dish, vocab) for dish in dishes], dtype=float)
        probabilities = model.predict_proba(predict_matrix)[:, 1]
        raw_scores = {
            int(dish["id"]): float(probabilities[index])
            for index, dish in enumerate(dishes)
        }
        print(json.dumps({"mode": "xgboost", "preferenceScores": normalize_scores(raw_scores)}))
    except Exception:
        print(json.dumps({"mode": "logistic_fallback", "preferenceScores": build_logistic_fallback_scores(dishes, history_items, vocab)}))


if __name__ == "__main__":
    main()
