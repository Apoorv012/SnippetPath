// @author: Apoorv012

#include <bits/stdc++.h>
using namespace std;

using ll = long long;
const int MOD = 1e9 + 7;
#define int long long

#define InVec(v, n) vector<int> v(n); for(auto &i : v) cin >> i

template <typename T>
void __print(const T &x) { cerr << x; }

template <typename T>
void __print(const vector<T> &x) {
    cerr << "[";
    for (int i = 0; i < x.size(); ++i) {
        __print(x[i]);
        if (i != x.size() - 1) cerr << ", ";
    }
    cerr << "]";
}

#ifndef ONLINE_JUDGE
#define debug(x) cerr << #x << " = "; __print(x); cerr << endl;
#else
#define debug(x)
#endif

void solve() {
    ${1:// your code here}
    
}

int32_t main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int t = 1;
    // cin >> t;

    while (t--)
        solve();

    return 0;
}