struct SegmentTree {
	int n;
	vector<long long> tree;

	SegmentTree(int n) : n(n), tree(4 * n, 0) {}

	void update(int node, int start, int end, int idx, long long val) {
		if (start == end) {
			tree[node] = val;
			return;
		}
		int mid = (start + end) / 2;
		if (idx <= mid) update(2 * node, start, mid, idx, val);
		else update(2 * node + 1, mid + 1, end, idx, val);
		tree[node] = tree[2 * node] + tree[2 * node + 1];
	}

	long long query(int node, int start, int end, int l, int r) {
		if (r < start || end < l) return 0;
		if (l <= start && end <= r) return tree[node];
		int mid = (start + end) / 2;
		return query(2 * node, start, mid, l, r) + query(2 * node + 1, mid + 1, end, l, r);
	}
};

$0
